import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, followUps, interactions, opportunities, quotations, stageTransitions, tasks, users } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { canDecide, decideApproval, markInteractionSent, requestApproval } from "@/lib/domain/approvals";
import { assignLead } from "@/lib/domain/assignment";
import { intakeLead, qualifyLead } from "@/lib/domain/leads";
import { scheduleFollowUp, transitionOpportunity } from "@/lib/domain/pipeline";
import { setEmailSender } from "@/lib/integrations/email";
import { agent, createTestDb, strongLead } from "./helpers";

async function setup() {
  const db = await createTestDb();
  const r = await intakeLead(db, strongLead(), await agent(db, "lead_gen_specialist"));
  await qualifyLead(db, r.leadId, await agent(db, "lead_qualification_specialist"));
  const a = await assignLead(db, r.leadId, await agent(db, "sales_director"));
  const [opp] = await db.select().from(opportunities);
  const [manager] = await db.insert(users).values({ email: "mgr@x.test", name: "Sales Manager", passwordHash: "x", role: "sales_manager" }).returning();
  const [viewer] = await db.insert(users).values({ email: "v@x.test", name: "Viewer", passwordHash: "x", role: "viewer" }).returning();
  return { db, opp, exec: { type: "agent" as const, id: a.employeeId! }, manager, viewer, companyId: r.companyId };
}

async function draftOutreach(db: DB, oppId: string, companyId: string, execId: string) {
  const [ix] = await db.insert(interactions).values({ opportunityId: oppId, companyId, employeeId: execId, channel: "email", direction: "outbound", status: "pending_approval", subject: "Intro", body: "Hello" }).returning();
  const ap = await requestApproval(db, { action: "send_external_email", title: "Outreach", summary: "s", payload: { interactionId: ix.id, toEmail: "p@x.ae", channel: "email" }, requestedByEmployeeId: execId, relatedType: "opportunity", relatedId: oppId });
  return { ix, ap };
}

describe("pipeline transition guards", () => {
  it("blocks 'Contacted' without a recorded customer interaction", async () => {
    const { db, opp, exec } = await setup();
    await expect(transitionOpportunity(db, opp.id, "contacted", exec)).rejects.toThrow(/customer interaction/);
  });

  it("blocks Quotation Sent without an approved quotation", async () => {
    const { db, opp, exec, companyId } = await setup();
    await db.insert(interactions).values({ opportunityId: opp.id, companyId, channel: "email", direction: "inbound", status: "received", subject: "RFQ" });
    await expect(transitionOpportunity(db, opp.id, "quotation_sent", exec)).rejects.toThrow(/approved quotation/);
    await db.insert(quotations).values({ opportunityId: opp.id, status: "approved" });
    await transitionOpportunity(db, opp.id, "quotation_sent", exec);
    const t = await db.select().from(stageTransitions).where(eq(stageTransitions.opportunityId, opp.id));
    expect(t.map((x) => x.toStage)).toContain("quotation_sent");
  });

  it("an AI employee can never mark Won directly", async () => {
    const { db, opp, exec, companyId } = await setup();
    await db.insert(interactions).values({ opportunityId: opp.id, companyId, channel: "email", direction: "inbound", status: "received" });
    await expect(transitionOpportunity(db, opp.id, "won", exec, { wonEvidence: "PO 123" })).rejects.toThrow(/approved 'mark deal won'/);
  });

  it("requires reasons for Lost/Disqualified and cancels pending follow-ups", async () => {
    const { db, opp, exec } = await setup();
    await scheduleFollowUp(db, opp.id, new Date(Date.now() + 86400_000), "Chase", exec);
    await expect(transitionOpportunity(db, opp.id, "lost", exec)).rejects.toThrow(/reason/);
    await transitionOpportunity(db, opp.id, "lost", exec, { lostReason: "Chose competitor on price" });
    const [f] = await db.select().from(followUps);
    expect(f.status).toBe("cancelled");
    await expect(transitionOpportunity(db, opp.id, "qualified", exec)).rejects.toThrow(/human/);
  });

  it("AI employees cannot move deals backwards; every active stage needs a next action", async () => {
    const { db, opp, exec } = await setup();
    await expect(transitionOpportunity(db, opp.id, "researching", exec)).rejects.toThrow(/human decision/);
    await db.update(opportunities).set({ nextAction: null, nextActionDue: null }).where(eq(opportunities.id, opp.id));
    await expect(transitionOpportunity(db, opp.id, "initial_contact_drafted", exec)).rejects.toThrow(/next action/);
  });
});

describe("human approval system", () => {
  it("enforces role permissions", () => {
    expect(canDecide("sales_manager", "send_external_email")).toBe(true);
    expect(canDecide("sales_manager", "change_product_price")).toBe(false);
    expect(canDecide("marketing_manager", "send_quotation")).toBe(false);
    expect(canDecide("viewer", "publish_content")).toBe(false);
  });

  it("rejection requires feedback and creates a revision task for the same executive", async () => {
    const { db, opp, exec, companyId, manager, viewer } = await setup();
    const { ap, ix } = await draftOutreach(db, opp.id, companyId, exec.id);
    await expect(decideApproval(db, ap.id, "approved", viewer)).rejects.toThrow(/cannot decide/);
    await expect(decideApproval(db, ap.id, "rejected", manager)).rejects.toThrow(/reason/);
    await decideApproval(db, ap.id, "rejected", manager, "Too long; mention Perkins range");
    const [i] = await db.select().from(interactions).where(eq(interactions.id, ix.id));
    expect(i.status).toBe("rejected");
    const rev = await db.select().from(tasks).where(eq(tasks.type, "outreach.draft"));
    expect(rev).toHaveLength(1);
    expect(rev[0].assigneeEmployeeId).toBe(exec.id);
    expect((rev[0].input as { feedback: string }).feedback).toMatch(/Perkins/);
    await expect(decideApproval(db, ap.id, "approved", manager)).rejects.toThrow(/already/);
  });

  it("approval without an email integration is 'manual required'; marking sent moves to Contacted with a follow-up", async () => {
    const { db, opp, exec, companyId, manager } = await setup();
    setEmailSender(null);
    const { ap, ix } = await draftOutreach(db, opp.id, companyId, exec.id);
    const r = await decideApproval(db, ap.id, "approved", manager);
    expect(r.execution.status).toBe("manual_required");
    const [stillPending] = await db.select().from(opportunities);
    expect(stillPending.stage).toBe("qualified");
    await markInteractionSent(db, ix.id, { type: "user", id: manager.id });
    const [o] = await db.select().from(opportunities);
    expect(o.stage).toBe("contacted");
    expect(await db.select().from(followUps)).toHaveLength(1);
  });

  it("with an email integration, approved emails are dispatched automatically", async () => {
    const { db, opp, exec, companyId, manager } = await setup();
    const sent: string[] = [];
    setEmailSender({ name: "test", send: async (m) => void sent.push(m.to) });
    const { ap } = await draftOutreach(db, opp.id, companyId, exec.id);
    const r = await decideApproval(db, ap.id, "approved", manager);
    setEmailSender(null);
    expect(r.execution.status).toBe("executed");
    expect(sent).toEqual(["p@x.ae"]);
    const [o] = await db.select().from(opportunities);
    expect(o.stage).toBe("contacted");
  });

  it("'mark deal won' approval transitions the opportunity with evidence", async () => {
    const { db, opp, exec, companyId, manager } = await setup();
    await db.insert(interactions).values({ opportunityId: opp.id, companyId, channel: "email", direction: "inbound", status: "received" });
    const ap = await requestApproval(db, { action: "mark_deal_won", title: "Won", summary: "PO received", payload: { wonEvidence: "PO #4471 dated 2026-11-07", actualValueAed: "312000.00" }, requestedByEmployeeId: exec.id, relatedType: "opportunity", relatedId: opp.id });
    await decideApproval(db, ap.id, "approved", manager);
    const [o] = await db.select().from(opportunities);
    expect(o.stage).toBe("won");
    expect(o.wonEvidence).toMatch(/PO #4471/);
    expect(o.actualValueAed).toBe("312000.00");
    const [a] = await db.select().from(approvals).where(eq(approvals.id, ap.id));
    expect(a.executionStatus).toBe("executed");
  });
});
