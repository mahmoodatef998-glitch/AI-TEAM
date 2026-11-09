import { eq } from "drizzle-orm";
import { z } from "zod";
import { interactions, opportunities, products, rfqs, type RfqRequirement } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { generateStructured } from "@/lib/ai/router";
import { logActivity, type Actor } from "@/lib/domain/activity";
import { getEmployeeByRole } from "@/lib/domain/employees";
import { sendMessage } from "@/lib/domain/messaging";
import { addBusinessDays, stageIndex, transitionOpportunity, type Stage } from "@/lib/domain/pipeline";
import { analyzeRfq } from "@/lib/domain/rfq";
import { createTask } from "@/lib/domain/tasks";
import type { Skill } from "../types";
import { NonRetryableError } from "../types";

const RequirementSchema = z.object({
  quantity: z.number().nullable(),
  primeKva: z.number().nullable(),
  standbyKva: z.number().nullable(),
  frequencyHz: z.number().nullable(),
  voltage: z.string().nullable(),
  phase: z.number().nullable(),
  brandPreference: z.string().nullable(),
  canopy: z.string().nullable(),
  fuelTankHours: z.number().nullable(),
  fuelTankLiters: z.number().nullable(),
  ats: z.boolean().nullable(),
  atsRatingA: z.number().nullable(),
  synchronization: z.boolean().nullable(),
  ambientTempC: z.number().nullable(),
  application: z.string().nullable(),
  deliveryLocation: z.string().nullable(),
  requiredDelivery: z.string().nullable(),
  installationRequired: z.boolean().nullable(),
  loadBankTest: z.boolean().nullable(),
  notes: z.string().nullable(),
});

/** Record an incoming RFQ against an opportunity and hand it to Technical Sales. */
export async function receiveRfq(db: DB, opportunityId: string, input: { rawText?: string; requirements?: RfqRequirement }, actor: Actor) {
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp) throw new Error("Opportunity not found");
  if (!input.rawText?.trim() && !input.requirements) throw new Error("Provide the RFQ text or structured requirements");
  const [rfq] = await db
    .insert(rfqs)
    .values({ opportunityId, rawText: input.rawText ?? null, requirements: input.requirements ?? null, extractionMethod: input.requirements ? "manual" : null })
    .returning();
  await db.insert(interactions).values({
    opportunityId,
    companyId: opp.companyId,
    channel: "rfq",
    direction: "inbound",
    status: "received",
    subject: "RFQ received",
    body: input.rawText ?? JSON.stringify(input.requirements),
    userId: actor.type === "user" ? actor.id : null,
  });
  if (stageIndex(opp.stage as Stage) < stageIndex("rfq_received")) {
    await transitionOpportunity(db, opportunityId, "rfq_received", actor, {
      note: "RFQ received",
      nextAction: "Technical evaluation of RFQ",
      nextActionDue: addBusinessDays(new Date(), 1),
    });
  }
  const tech = await getEmployeeByRole(db, "technical_sales_assistant");
  await createTask(db, {
    type: "rfq.analyze",
    title: `Analyse RFQ: ${opp.title}`,
    assigneeEmployeeId: tech.id,
    createdBy: actor,
    relatedType: "opportunity",
    relatedId: opportunityId,
    priority: 9,
    input: { rfqId: rfq.id },
    dedupeKey: `rfq:${rfq.id}`,
  });
  await sendMessage(db, {
    fromEmployeeId: opp.ownerEmployeeId,
    toEmployeeId: tech.id,
    kind: "task_assignment",
    subject: `RFQ for technical evaluation: ${opp.title}`,
    body: "RFQ received from my customer. Please extract requirements, flag missing information and conflicts, and check against the approved catalogue.",
    relatedType: "opportunity",
    relatedId: opportunityId,
  });
  await logActivity(db, actor, "rfq.received", `RFQ received: ${opp.title}`, { entityType: "opportunity", entityId: opportunityId });
  return rfq;
}

export const rfqAnalyze: Skill = {
  type: "rfq.analyze",
  label: "Technical RFQ analysis",
  office: { status: "preparing_quotation", location: "operations_room" },
  async run({ db, task, employee, actor, progress }) {
    const rfqId = typeof task.input.rfqId === "string" ? task.input.rfqId : null;
    if (!rfqId) throw new NonRetryableError("rfqId missing");
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    if (!rfq) throw new NonRetryableError("RFQ not found");
    let req = rfq.requirements;
    let method = rfq.extractionMethod ?? "manual";
    if (!req) {
      if (!rfq.rawText) throw new NonRetryableError("RFQ has neither text nor requirements");
      await progress(20, "Extracting requirements");
      req = await generateStructured(
        { db, employeeId: employee.id, taskId: task.id },
        {
          profile: "technical",
          system: `You are a diesel generator application engineer. Extract ONLY what the RFQ states. Use null for anything not explicitly stated — never infer ratings, voltage or frequency. Prime vs standby: only fill the one the RFQ names; if it says just "kVA" with no duty, put it in notes and leave both null.`,
          prompt: `RFQ TEXT:\n${rfq.rawText}`,
          schema: RequirementSchema,
        },
      );
      method = "llm";
    }
    await progress(60, "Checking against catalogue");
    const catalogue = await db.select().from(products).where(eq(products.active, true));
    const a = analyzeRfq(req, catalogue);
    const status = a.readyForQuotation ? "ready_for_quotation" : a.missingInfo.length || a.conflicts.length ? "awaiting_customer_info" : "analyzed";
    await db
      .update(rfqs)
      .set({
        requirements: req,
        extractionMethod: method,
        missingInfo: a.missingInfo,
        conflicts: [...a.conflicts, ...a.warnings.map((w) => `WARNING: ${w}`)],
        complianceMatrix: { rows: a.complianceMatrix, matches: a.matches.map((m) => ({ productId: m.product.id, note: m.fitNote })), fullLoadCurrentA: a.fullLoadCurrentA },
        customerQuestions: a.customerQuestions,
        status,
        updatedAt: new Date(),
      })
      .where(eq(rfqs.id, rfqId));
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, rfq.opportunityId));
    if (opp && opp.stage === "rfq_received") {
      await transitionOpportunity(db, opp.id, "technical_evaluation", actor, {
        note: `RFQ analysed: ${a.missingInfo.length} missing, ${a.conflicts.length} conflicts`,
        nextAction: a.customerQuestions.length ? "Send clarification questions to customer (approval required)" : "Prepare quotation",
        nextActionDue: addBusinessDays(new Date(), 1),
      });
    }
    if (opp) {
      await sendMessage(db, {
        fromEmployeeId: employee.id,
        toEmployeeId: opp.ownerEmployeeId,
        kind: "report",
        subject: `RFQ analysis: ${opp.title}`,
        body: `Missing: ${a.missingInfo.join(", ") || "none"}.\nConflicts: ${a.conflicts.join(" ") || "none"}.\nWarnings: ${a.warnings.join(" ") || "none"}.\nCatalogue matches: ${a.matches.map((m) => m.fitNote).join("; ") || (a.catalogueEmpty ? "catalogue not loaded" : "none")}.\nQuestions for customer:\n${a.customerQuestions.map((q) => `• ${q}`).join("\n") || "none"}`,
        relatedType: "opportunity",
        relatedId: opp.id,
      });
    }
    return {
      status: "completed",
      summary: `RFQ analysed (${method}): ${a.missingInfo.length} missing, ${a.conflicts.length} conflict(s), ${a.matches.length} match(es).`,
      output: { status, ...a, matches: a.matches.map((m) => m.fitNote) },
    };
  },
};

