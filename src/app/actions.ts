"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getDb } from "@/lib/db";
import { classifyDbError } from "@/lib/db/health";
import {
  businessTargets,
  knowledgeItems,
  leads,
  modelRoutes,
  opportunities,
  products,
  schedules,
  users,
  interactions,
} from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession, requireRole, SALES_MANAGE, WRITE_ROLES } from "@/lib/auth/session";
import { tick } from "@/lib/agents/worker";
import { receiveRfq } from "@/lib/agents/skills/technical";
import { logActivity, type Actor } from "@/lib/domain/activity";
import { decideApproval, markInteractionSent, requestApproval } from "@/lib/domain/approvals";
import { assignLead, reassignAccount } from "@/lib/domain/assignment";
import { getEmployeeByRole } from "@/lib/domain/employees";
import { intakeLead } from "@/lib/domain/leads";
import { submitManualOutreach } from "@/lib/domain/outreach";
import { completeFollowUp, scheduleFollowUp, setNextAction, transitionOpportunity, type Stage } from "@/lib/domain/pipeline";
import { cancelTask, createTask, requeueTask } from "@/lib/domain/tasks";
import { cronMatches } from "@/lib/agents/cron";

export type ActionState = { ok?: string; error?: string } | null;

const s = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const num = (f: FormData, k: string) => {
  const v = s(f, k);
  return v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
};
const userActor = (id: string): Actor => ({ type: "user", id });

/** Kick the agent queue right after the response is sent, so work proceeds without a separate worker. */
function kickQueue() {
  after(async () => {
    try {
      await tick(getDb(), { workerId: `web-${process.pid}`, maxTasks: 10, timeBudgetMs: 55_000 });
    } catch (e) {
      console.error("queue tick failed", e);
    }
  });
}

async function guard<T>(fn: () => Promise<T>, okMsg: string, paths: string[] = []): Promise<ActionState> {
  try {
    await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: okMsg };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ───────────── auth ─────────────

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  const email = s(form, "email")?.toLowerCase();
  const password = s(form, "password");
  if (!email || !password) return { error: "Email and password are required." };
  try {
    const [u] = await getDb().select().from(users).where(eq(users.email, email));
    if (!u || !u.active || !(await verifyPassword(password, u.passwordHash))) {
      return { error: "Those credentials don't match an active account." };
    }
    await createSession(u.id);
    await logActivity(getDb(), userActor(u.id), "user.login", `${u.name} signed in`);
  } catch (e) {
    const d = classifyDbError(e);
    console.error(`[login] database error (${d.kind}${d.code ? `, ${d.code}` : ""}): ${d.message}`);
    return { error: `Sign-in is unavailable: the server cannot reach its database (${d.kind.replace(/_/g, " ")}). ${d.hint}` };
  }
  // redirect() throws, so it must stay outside the try block.
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function createUserAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const admin = await requireRole(["admin"]);
    const email = s(form, "email")?.toLowerCase();
    const name = s(form, "name");
    const role = s(form, "role") as (typeof users.$inferInsert)["role"];
    const password = s(form, "password");
    if (!email || !name || !role || !password) throw new Error("All fields are required.");
    await getDb().insert(users).values({ email, name, role, passwordHash: await hashPassword(password) });
    await logActivity(getDb(), userActor(admin.id), "user.created", `User ${email} created with role ${role}`);
  }, "User created.", ["/settings"]);
}

// ───────────── leads ─────────────

export async function createLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const u = await requireRole(WRITE_ROLES);
    const evidenceUrl = s(form, "evidenceUrl");
    const r = await intakeLead(
      getDb(),
      {
        company: {
          name: s(form, "companyName") ?? "",
          website: s(form, "website"),
          country: s(form, "country"),
          city: s(form, "city"),
          industry: s(form, "industry"),
          accountType: s(form, "accountType"),
          businessActivity: s(form, "businessActivity"),
          companySize: s(form, "companySize"),
          companySizeVerified: form.get("companySizeVerified") === "on",
        },
        contacts: s(form, "contactSourceUrl")
          ? [{
              name: s(form, "contactName"),
              jobTitle: s(form, "contactTitle"),
              isDecisionMaker: form.get("contactIsDecisionMaker") === "on",
              email: s(form, "contactEmail"),
              phone: s(form, "contactPhone"),
              sourceUrl: s(form, "contactSourceUrl")!,
            }]
          : [],
        evidence: evidenceUrl
          ? [{ evidenceType: s(form, "evidenceType") ?? "other", url: evidenceUrl, title: s(form, "evidenceTitle") ?? evidenceUrl, excerpt: s(form, "evidenceExcerpt"), reliability: (s(form, "evidenceReliability") as "high" | "medium" | "low") ?? "medium" }]
          : [],
        lead: {
          requirementSummary: s(form, "requirementSummary"),
          capacityKvaMin: num(form, "capacityKvaMin"),
          capacityKvaMax: num(form, "capacityKvaMax"),
          brandPreference: s(form, "brandPreference"),
          signalStrength: (s(form, "signalStrength") as never) ?? "speculative",
          buyingSignal: s(form, "buyingSignal"),
          hasActiveProject: form.get("hasActiveProject") === "on",
          purchaseTiming: s(form, "purchaseTiming") ?? "unknown",
          source: s(form, "source") ?? "manual_entry",
          sourceUrl: s(form, "sourceUrl"),
        },
        createdByUserId: u.id,
      },
      userActor(u.id),
    );
    kickQueue();
    revalidatePath("/leads");
    return {
      ok:
        r.outcome === "created"
          ? "Lead created and queued for qualification."
          : r.outcome === "merged_into_open_lead"
            ? "This company already has an open lead — the new information was merged into it."
            : "This company is already an owned account — the owner has been notified instead of creating a duplicate.",
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function qualifyNowAction(leadId: string) {
  const u = await requireRole(WRITE_ROLES);
  const db = getDb();
  const q = await getEmployeeByRole(db, "lead_qualification_specialist");
  await db.update(leads).set({ status: "new" }).where(and(eq(leads.id, leadId), eq(leads.status, "needs_more_research")));
  await createTask(db, { type: "lead.qualify", title: "Re-qualify lead (requested by user)", assigneeEmployeeId: q.id, createdBy: userActor(u.id), relatedType: "lead", relatedId: leadId, priority: 7, input: { leadId }, dedupeKey: `qualify:lead:${leadId}` });
  kickQueue();
  revalidatePath(`/leads/${leadId}`);
}

export async function researchLeadAction(leadId: string) {
  const u = await requireRole(WRITE_ROLES);
  const db = getDb();
  const r = await getEmployeeByRole(db, "lead_research_manager");
  await createTask(db, { type: "lead.research", title: "Research lead (requested by user)", assigneeEmployeeId: r.id, createdBy: userActor(u.id), relatedType: "lead", relatedId: leadId, priority: 6, input: { leadId }, dedupeKey: `research:lead:${leadId}` });
  kickQueue();
  revalidatePath(`/leads/${leadId}`);
}

export async function rejectLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(SALES_MANAGE);
    const leadId = s(form, "leadId")!;
    const reason = s(form, "reason");
    if (!reason) throw new Error("A reason is required.");
    await getDb().update(leads).set({ status: "rejected", rejectionReason: reason, updatedAt: new Date() }).where(eq(leads.id, leadId));
    await logActivity(getDb(), userActor(u.id), "lead.rejected", `Lead rejected: ${reason}`, { entityType: "lead", entityId: leadId });
  }, "Lead rejected.", ["/leads"]);
}

export async function assignLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const u = await requireRole(SALES_MANAGE);
    const leadId = s(form, "leadId")!;
    const employeeId = s(form, "employeeId");
    const r = await assignLead(getDb(), leadId, userActor(u.id), employeeId ? { overrideEmployeeId: employeeId, reason: s(form, "reason") ?? undefined } : {});
    kickQueue();
    revalidatePath(`/leads/${leadId}`);
    return { ok: r.alreadyAssigned ? "Lead was already assigned." : `Assigned to ${r.employeeName}.` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function reassignAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(SALES_MANAGE);
    await reassignAccount(getDb(), s(form, "companyId")!, s(form, "employeeId")!, s(form, "reason") ?? "", userActor(u.id));
  }, "Account reassigned.", ["/pipeline"]);
}

// ───────────── opportunities ─────────────

export async function transitionAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(WRITE_ROLES);
    const id = s(form, "opportunityId")!;
    const due = s(form, "nextActionDue");
    await transitionOpportunity(getDb(), id, s(form, "stage") as Stage, userActor(u.id), {
      note: s(form, "note") ?? undefined,
      nextAction: s(form, "nextAction") ?? undefined,
      nextActionDue: due ? new Date(due) : undefined,
      lostReason: s(form, "lostReason") ?? undefined,
      disqualifiedReason: s(form, "disqualifiedReason") ?? undefined,
    });
  }, "Stage updated.", ["/pipeline"]);
}

export async function nextActionAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(WRITE_ROLES);
    const due = s(form, "nextActionDue");
    if (!s(form, "nextAction") || !due) throw new Error("Next action and due date are required.");
    await setNextAction(getDb(), s(form, "opportunityId")!, s(form, "nextAction")!, new Date(due), userActor(u.id));
  }, "Next action saved.");
}

export async function setValueAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(SALES_MANAGE);
    const id = s(form, "opportunityId")!;
    const v = num(form, "expectedValueAed");
    await getDb()
      .update(opportunities)
      .set({ expectedValueAed: v == null ? null : v.toFixed(2), valueIsEstimate: form.get("valueIsEstimate") === "on", expectedCloseDate: s(form, "expectedCloseDate"), updatedAt: new Date() })
      .where(eq(opportunities.id, id));
    await logActivity(getDb(), userActor(u.id), "opportunity.value_set", `Expected value set to AED ${v ?? "—"}`, { entityType: "opportunity", entityId: id });
  }, "Value saved.");
}

export async function logInteractionAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(WRITE_ROLES);
    const id = s(form, "opportunityId")!;
    const [opp] = await getDb().select().from(opportunities).where(eq(opportunities.id, id));
    const direction = s(form, "direction") ?? "inbound";
    await getDb().insert(interactions).values({
      opportunityId: id,
      companyId: opp.companyId,
      userId: u.id,
      channel: s(form, "channel") ?? "note",
      direction,
      status: direction === "inbound" ? "received" : "logged",
      subject: s(form, "subject"),
      body: s(form, "body"),
    });
    await getDb().update(opportunities).set({ lastActivityAt: new Date() }).where(eq(opportunities.id, id));
    await logActivity(getDb(), userActor(u.id), "interaction.logged", `Interaction logged: ${s(form, "subject") ?? s(form, "channel")}`, { entityType: "opportunity", entityId: id });
  }, "Interaction recorded.");
}

export async function markSentAction(interactionId: string, opportunityId: string) {
  const u = await requireRole(WRITE_ROLES);
  await markInteractionSent(getDb(), interactionId, userActor(u.id));
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function followUpAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(WRITE_ROLES);
    const due = s(form, "dueAt");
    if (!due) throw new Error("Due date required.");
    await scheduleFollowUp(getDb(), s(form, "opportunityId")!, new Date(due), s(form, "purpose") ?? "Follow up", userActor(u.id));
  }, "Follow-up scheduled.");
}

export async function completeFollowUpAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(WRITE_ROLES);
    await completeFollowUp(getDb(), s(form, "followUpId")!, s(form, "outcome") ?? "Done", userActor(u.id));
  }, "Follow-up completed.");
}

export async function receiveRfqAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const u = await requireRole(WRITE_ROLES);
    const id = s(form, "opportunityId")!;
    const structured = form.get("structured") === "on";
    const bool = (k: string) => (s(form, k) == null ? null : s(form, k) === "yes");
    await receiveRfq(
      getDb(),
      id,
      structured
        ? {
            rawText: s(form, "rawText") ?? undefined,
            requirements: {
              quantity: num(form, "quantity"), primeKva: num(form, "primeKva"), standbyKva: num(form, "standbyKva"),
              frequencyHz: num(form, "frequencyHz"), voltage: s(form, "voltage"), phase: num(form, "phase"),
              brandPreference: s(form, "brandPreference"), canopy: s(form, "canopy"), fuelTankHours: num(form, "fuelTankHours"),
              ats: bool("ats"), atsRatingA: num(form, "atsRatingA"), synchronization: bool("synchronization"),
              ambientTempC: num(form, "ambientTempC"), deliveryLocation: s(form, "deliveryLocation"), installationRequired: bool("installationRequired"),
            },
          }
        : { rawText: s(form, "rawText") ?? undefined },
      userActor(u.id),
    );
    kickQueue();
    revalidatePath(`/opportunities/${id}`);
    return { ok: "RFQ recorded and sent to Technical Sales for analysis." };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function requestWonAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(WRITE_ROLES);
    const id = s(form, "opportunityId")!;
    const evidence = s(form, "wonEvidence");
    if (!evidence) throw new Error("Evidence is required (PO number, signed order, payment reference).");
    const [opp] = await getDb().select().from(opportunities).where(eq(opportunities.id, id));
    await requestApproval(getDb(), {
      action: "mark_deal_won",
      title: `Mark won: ${opp.title}`,
      summary: `Evidence: ${evidence}. Actual value: AED ${s(form, "actualValueAed") ?? "not given"}`,
      payload: { wonEvidence: evidence, actualValueAed: num(form, "actualValueAed")?.toFixed(2) ?? null },
      requestedByUserId: u.id,
      relatedType: "opportunity",
      relatedId: id,
    });
  }, "Won approval requested.", ["/approvals"]);
}

export async function manualOutreachAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(WRITE_ROLES);
    await submitManualOutreach(
      getDb(),
      {
        opportunityId: s(form, "opportunityId")!,
        contactId: s(form, "contactId") ?? "",
        channel: s(form, "channel") === "linkedin" ? "linkedin" : "email",
        subject: s(form, "subject"),
        body: s(form, "body") ?? "",
      },
      u.id,
    );
  }, "Sent for approval — see the Approvals page.", ["/approvals"]);
}

// ───────────── approvals ─────────────

export async function decideApprovalAction(_: ActionState, form: FormData): Promise<ActionState> {
  const approvalId = s(form, "approvalId")!;
  try {
    const u = await requireRole(["admin", "sales_manager", "marketing_manager"]);
    await decideApproval(getDb(), approvalId, s(form, "decision") as "approved" | "rejected", u, s(form, "note") ?? undefined);
    kickQueue();
    revalidatePath("/approvals");
  } catch (e) {
    return { error: (e as Error).message };
  }
  // The decided item leaves the pending list, so show the outcome as a banner on the page.
  redirect(`/approvals?decided=${approvalId}`);
}

// ───────────── tasks & agents ─────────────

const USER_LAUNCHABLE: Record<string, { role: string; title: (i: Record<string, string | null>) => string }> = {
  "lead.discover": { role: "lead_gen_specialist", title: (i) => `Discovery run: ${i.segment ?? "default segment"}` },
  "seo.audit": { role: "seo_specialist", title: () => "Technical SEO audit of 4ugenerators.com" },
  "content.draft": { role: "content_creator", title: (i) => `Content draft: ${(i.brief ?? "").slice(0, 60)}` },
  "competitor.research": { role: "market_intelligence_analyst", title: (i) => `Competitor research: ${i.scope ?? "UAE generator suppliers"}` },
  "marketing.plan": { role: "marketing_director", title: () => "Marketing strategy & campaign plan" },
  "ads.review": { role: "performance_marketing_specialist", title: () => "Google Ads review" },
  "kpi.plan": { role: "cgo", title: () => "KPI plan refresh" },
  "pipeline.review": { role: "sales_director", title: () => "Pipeline review (requested)" },
  "report.daily_performance": { role: "business_analyst", title: () => "Performance report (requested)" },
  "briefing.daily": { role: "cgo", title: () => "Executive briefing (requested)" },
  "lead.assign": { role: "sales_director", title: () => "Assign all qualified leads" },
};

export async function launchTaskAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const u = await requireRole(WRITE_ROLES);
    const type = s(form, "type")!;
    const def = USER_LAUNCHABLE[type];
    if (!def) throw new Error("This task type cannot be launched manually.");
    const input: Record<string, string | null> = {};
    for (const k of ["segment", "country", "maxCandidates", "brief", "scope", "maxPages"]) if (s(form, k)) input[k] = s(form, k);
    const e = await getEmployeeByRole(getDb(), def.role);
    await createTask(getDb(), { type, title: def.title(input), assigneeEmployeeId: e.id, createdBy: userActor(u.id), priority: 6, input });
    kickQueue();
    revalidatePath("/tasks");
    return { ok: `Task assigned to ${e.name}.` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function requeueTaskAction(taskId: string) {
  const u = await requireRole(WRITE_ROLES);
  await requeueTask(getDb(), taskId, userActor(u.id));
  kickQueue();
  revalidatePath("/tasks");
}

export async function cancelTaskAction(taskId: string) {
  const u = await requireRole(WRITE_ROLES);
  await cancelTask(getDb(), taskId, userActor(u.id));
  revalidatePath("/tasks");
}

export async function runQueueAction() {
  await requireRole(["admin", "sales_manager"]);
  kickQueue();
  revalidatePath("/tasks");
}

// ───────────── settings / knowledge ─────────────

export async function setTargetAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(["admin"]);
    const period = s(form, "period");
    const value = num(form, "value");
    if (!period || !/^\d{4}-\d{2}$/.test(period) || value == null || value <= 0) throw new Error("Enter a period (YYYY-MM) and a positive AED amount.");
    await getDb()
      .insert(businessTargets)
      .values({ period, metric: "closed_revenue_aed", value: value.toFixed(2), setByUserId: u.id, isAssumption: false })
      .onConflictDoUpdate({ target: [businessTargets.period, businessTargets.metric], set: { value: value.toFixed(2), setByUserId: u.id } });
    await logActivity(getDb(), userActor(u.id), "target.set", `Revenue target ${period}: AED ${value.toLocaleString()}`);
    const cgo = await getEmployeeByRole(getDb(), "cgo");
    await createTask(getDb(), { type: "kpi.plan", title: `KPI plan for ${period}`, assigneeEmployeeId: cgo.id, createdBy: userActor(u.id), priority: 8, input: {}, dedupeKey: `kpi:${period}` });
    kickQueue();
  }, "Target saved — the CGO will translate it into KPIs.", ["/", "/settings"]);
}

export async function scheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(["admin"]);
    const id = s(form, "scheduleId")!;
    const cron = s(form, "cron");
    if (cron) cronMatches(cron, new Date(), "Asia/Dubai"); // validates syntax
    await getDb().update(schedules).set({ enabled: form.get("enabled") === "on", ...(cron ? { cron } : {}) }).where(eq(schedules.id, id));
    await logActivity(getDb(), userActor(u.id), "schedule.updated", `Schedule updated (${cron ?? "enabled toggle"})`);
  }, "Schedule saved.", ["/settings"]);
}

export async function modelRouteAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(["admin"]);
    const provider = s(form, "provider");
    if (provider !== "anthropic" && provider !== "xai") throw new Error("Provider must be anthropic or xai.");
    await getDb().update(modelRoutes).set({ provider, model: s(form, "model")!, effort: s(form, "effort"), updatedAt: new Date() }).where(eq(modelRoutes.profile, s(form, "profile")!));
    await logActivity(getDb(), userActor(u.id), "model_route.updated", `Model route ${s(form, "profile")} → ${provider}/${s(form, "model")}`);
  }, "Model route saved.", ["/settings"]);
}

export async function addKnowledgeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(["admin", "sales_manager", "marketing_manager"]);
    const title = s(form, "title");
    const content = s(form, "content");
    const source = s(form, "source");
    if (!title || !content || !source) throw new Error("Title, content and source are required.");
    const verified = form.get("verified") === "on" && u.role === "admin";
    await getDb().insert(knowledgeItems).values({ category: s(form, "category") ?? "company_profile", title, content, source, verified, verifiedByUserId: verified ? u.id : null, verifiedAt: verified ? new Date() : null });
    await logActivity(getDb(), userActor(u.id), "knowledge.added", `Knowledge added: ${title}${verified ? " (verified)" : ""}`);
  }, "Knowledge item added.", ["/knowledge"]);
}

export async function verifyKnowledgeAction(id: string, verified: boolean) {
  const u = await requireRole(["admin"]);
  await getDb().update(knowledgeItems).set({ verified, verifiedByUserId: verified ? u.id : null, verifiedAt: verified ? new Date() : null, updatedAt: new Date() }).where(eq(knowledgeItems.id, id));
  await logActivity(getDb(), userActor(u.id), "knowledge.verification_changed", `Knowledge item ${verified ? "verified" : "unverified"}`, { entityType: "knowledge", entityId: id });
  revalidatePath("/knowledge");
}

export async function addProductAction(_: ActionState, form: FormData): Promise<ActionState> {
  return guard(async () => {
    const u = await requireRole(["admin"]);
    const brand = s(form, "brand");
    const model = s(form, "model");
    const source = s(form, "source");
    if (!brand || !model || !source) throw new Error("Brand, model and source document are required.");
    const price = num(form, "priceAed");
    await getDb().insert(products).values({
      sku: s(form, "sku"), brand, model, primeKva: num(form, "primeKva"), standbyKva: num(form, "standbyKva"), frequencyHz: num(form, "frequencyHz"),
      voltage: s(form, "voltage"), phase: num(form, "phase"), engineModel: s(form, "engineModel"), alternator: s(form, "alternator"),
      fuelTankLiters: num(form, "fuelTankLiters"), canopy: s(form, "canopy"), maxAmbientC: num(form, "maxAmbientC"),
      priceAed: price?.toFixed(2) ?? null, priceVerified: price != null && form.get("priceVerified") === "on", availability: s(form, "availability") ?? "unknown", source,
    });
    await logActivity(getDb(), userActor(u.id), "product.added", `Catalogue product added: ${brand} ${model}`);
  }, "Product added to approved catalogue.", ["/knowledge"]);
}
