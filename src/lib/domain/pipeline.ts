import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { approvals, followUps, interactions, opportunities, quotations, stageTransitions } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { logActivity, type Actor } from "./activity";

export const STAGES = [
  { key: "new_lead", label: "New Lead", probability: 5 },
  { key: "researching", label: "Researching", probability: 5 },
  { key: "contact_identified", label: "Contact Identified", probability: 8 },
  { key: "qualified", label: "Qualified", probability: 10 },
  { key: "initial_contact_drafted", label: "Initial Contact Drafted", probability: 10 },
  { key: "awaiting_approval", label: "Awaiting Approval", probability: 10 },
  { key: "contacted", label: "Contacted", probability: 15 },
  { key: "interested", label: "Interested", probability: 25 },
  { key: "rfq_received", label: "RFQ Received", probability: 35 },
  { key: "technical_evaluation", label: "Technical Evaluation", probability: 40 },
  { key: "quotation_preparation", label: "Quotation Preparation", probability: 45 },
  { key: "quotation_sent", label: "Quotation Sent", probability: 50 },
  { key: "follow_up", label: "Follow-up", probability: 50 },
  { key: "negotiation", label: "Negotiation", probability: 65 },
  { key: "verbal_approval", label: "Verbal Approval", probability: 85 },
  { key: "won", label: "Won", probability: 100 },
  { key: "lost", label: "Lost", probability: 0 },
  { key: "disqualified", label: "Disqualified", probability: 0 },
] as const;

export type Stage = (typeof STAGES)[number]["key"];
export const TERMINAL_STAGES: Stage[] = ["won", "lost", "disqualified"];
export const ACTIVE_STAGES = STAGES.map((s) => s.key).filter((k) => !TERMINAL_STAGES.includes(k)) as Stage[];
export const stageIndex = (s: Stage) => STAGES.findIndex((x) => x.key === s);
export const stageLabel = (s: string) => STAGES.find((x) => x.key === s)?.label ?? s;
/** Stages that happen after the customer has been contacted. */
const POST_CONTACT: Stage[] = ACTIVE_STAGES.filter((s) => stageIndex(s) >= stageIndex("contacted"));
/** "Follow-up" may be re-entered from these stages (it is a recurring state, not strictly linear). */
const FOLLOW_UP_FROM: Stage[] = ["contacted", "interested", "quotation_sent", "negotiation", "verbal_approval", "technical_evaluation"];

export class TransitionError extends Error {}

export interface TransitionOptions {
  note?: string;
  nextAction?: string;
  nextActionDue?: Date;
  lostReason?: string;
  disqualifiedReason?: string;
  wonEvidence?: string;
  actualValueAed?: string;
  /** Set by approval execution: proof that a human approved marking the deal won. */
  wonApprovalId?: string;
}

export type Opportunity = typeof opportunities.$inferSelect;

/**
 * Validate a stage transition. Returns a list of violations (empty = allowed).
 * Rules:
 *  - Terminal stages are final; only a human can reopen lost/disqualified.
 *  - Moving backwards is a human decision (except re-entering Follow-up).
 *  - Contacted and later require evidence of contact (sent/received/logged interaction).
 *  - Quotation Sent requires an approved quotation.
 *  - Won requires written evidence AND an approved `mark_deal_won` approval; agents can only request it.
 *  - Lost / Disqualified require a reason.
 *  - Every active stage requires a next action with a due date.
 */
export async function validateTransition(db: DB, opp: Opportunity, to: Stage, actor: Actor, o: TransitionOptions): Promise<string[]> {
  const v: string[] = [];
  const from = opp.stage as Stage;
  if (from === to) v.push(`Opportunity is already in ${stageLabel(to)}.`);
  if (from === "won") v.push("Won deals are final.");
  if ((from === "lost" || from === "disqualified") && actor.type !== "user") v.push("Only a human can reopen a lost or disqualified opportunity.");
  const backwards = stageIndex(to) < stageIndex(from) && !TERMINAL_STAGES.includes(to);
  if (backwards && actor.type !== "user" && !(to === "follow_up" && FOLLOW_UP_FROM.includes(from)) && !TERMINAL_STAGES.includes(from)) {
    v.push(`Moving back from ${stageLabel(from)} to ${stageLabel(to)} requires a human decision.`);
  }
  if (to === "follow_up" && !FOLLOW_UP_FROM.includes(from) && !TERMINAL_STAGES.includes(from) && stageIndex(from) < stageIndex("contacted")) {
    v.push("Follow-up requires that the customer was contacted first.");
  }

  if (POST_CONTACT.includes(to) || to === "won") {
    const [c] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(interactions)
      .where(and(eq(interactions.opportunityId, opp.id), inArray(interactions.status, ["sent", "received", "logged"])));
    if (!c || c.n === 0) v.push(`${stageLabel(to)} requires a recorded customer interaction (sent, received or logged).`);
  }
  if (to === "quotation_sent") {
    const [q] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(quotations)
      .where(and(eq(quotations.opportunityId, opp.id), inArray(quotations.status, ["approved", "sent"])));
    if (!q || q.n === 0) v.push("Quotation Sent requires a human-approved quotation.");
  }
  if (to === "won") {
    if (!o.wonEvidence?.trim() && !opp.wonEvidence) v.push("Won requires verified evidence (e.g. PO number, signed order, payment reference).");
    let approved = false;
    if (o.wonApprovalId) {
      const [a] = await db.select().from(approvals).where(eq(approvals.id, o.wonApprovalId));
      approved = !!a && a.status === "approved" && a.action === "mark_deal_won" && a.relatedId === opp.id;
    }
    if (!approved) v.push("Won requires an approved 'mark deal won' approval.");
  }
  if (to === "lost" && !o.lostReason?.trim()) v.push("Lost requires a reason.");
  if (to === "disqualified" && !o.disqualifiedReason?.trim()) v.push("Disqualified requires a reason.");
  if (!TERMINAL_STAGES.includes(to)) {
    const nextAction = o.nextAction ?? opp.nextAction;
    const nextDue = o.nextActionDue ?? opp.nextActionDue;
    if (!nextAction?.trim() || !nextDue) v.push("Every active opportunity needs a next action and a due date.");
  }
  return v;
}

export async function transitionOpportunity(db: DB, opportunityId: string, to: Stage, actor: Actor, o: TransitionOptions = {}) {
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp) throw new TransitionError("Opportunity not found");
  const violations = await validateTransition(db, opp, to, actor, o);
  if (violations.length) throw new TransitionError(violations.join(" "));

  const now = new Date();
  const terminal = TERMINAL_STAGES.includes(to);
  const prob = STAGES.find((s) => s.key === to)!.probability;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    await tx
      .update(opportunities)
      .set({
        stage: to,
        probability: prob,
        nextAction: terminal ? null : (o.nextAction ?? opp.nextAction),
        nextActionDue: terminal ? null : (o.nextActionDue ?? opp.nextActionDue),
        lostReason: to === "lost" ? o.lostReason! : opp.lostReason,
        disqualifiedReason: to === "disqualified" ? o.disqualifiedReason! : opp.disqualifiedReason,
        wonEvidence: to === "won" ? (o.wonEvidence ?? opp.wonEvidence) : opp.wonEvidence,
        actualValueAed: to === "won" ? (o.actualValueAed ?? opp.actualValueAed) : opp.actualValueAed,
        closedAt: terminal ? now : null,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(opportunities.id, opportunityId));
    await tx.insert(stageTransitions).values({
      opportunityId,
      fromStage: opp.stage,
      toStage: to,
      actorType: actor.type,
      actorId: actor.id ?? null,
      note: o.note ?? o.lostReason ?? o.disqualifiedReason ?? o.wonEvidence ?? null,
    });
    if (terminal) {
      await tx
        .update(followUps)
        .set({ status: "cancelled" })
        .where(and(eq(followUps.opportunityId, opportunityId), eq(followUps.status, "pending")));
    }
  });
  await logActivity(db, actor, "opportunity.stage_changed", `${opp.title}: ${stageLabel(opp.stage)} → ${stageLabel(to)}`, {
    entityType: "opportunity",
    entityId: opportunityId,
    detail: { from: opp.stage, to, note: o.note ?? null },
  });
  return { from: opp.stage as Stage, to };
}

export async function setNextAction(db: DB, opportunityId: string, nextAction: string, due: Date, actor: Actor) {
  await db
    .update(opportunities)
    .set({ nextAction, nextActionDue: due, updatedAt: new Date() })
    .where(eq(opportunities.id, opportunityId));
  await logActivity(db, actor, "opportunity.next_action_set", `Next action: ${nextAction} (due ${due.toISOString().slice(0, 10)})`, {
    entityType: "opportunity",
    entityId: opportunityId,
  });
}

export async function scheduleFollowUp(db: DB, opportunityId: string, dueAt: Date, purpose: string, actor: Actor) {
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp) throw new Error("Opportunity not found");
  if (TERMINAL_STAGES.includes(opp.stage as Stage)) throw new Error("Cannot schedule follow-ups on a closed opportunity");
  const [f] = await db
    .insert(followUps)
    .values({ opportunityId, ownerEmployeeId: opp.ownerEmployeeId, dueAt, purpose })
    .returning();
  await logActivity(db, actor, "follow_up.scheduled", `Follow-up scheduled for ${dueAt.toISOString().slice(0, 10)}: ${purpose}`, {
    entityType: "opportunity",
    entityId: opportunityId,
  });
  return f;
}

export async function completeFollowUp(db: DB, followUpId: string, outcome: string, actor: Actor) {
  const [f] = await db
    .update(followUps)
    .set({ status: "done", completedAt: new Date(), outcome })
    .where(and(eq(followUps.id, followUpId), eq(followUps.status, "pending")))
    .returning();
  if (!f) throw new Error("Follow-up not found or already closed");
  await db.update(opportunities).set({ lastActivityAt: new Date() }).where(eq(opportunities.id, f.opportunityId));
  await logActivity(db, actor, "follow_up.completed", `Follow-up completed: ${outcome}`, {
    entityType: "opportunity",
    entityId: f.opportunityId,
  });
  return f;
}

export async function openOpportunitiesFor(db: DB, employeeId: string) {
  return db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.ownerEmployeeId, employeeId), notInArray(opportunities.stage, TERMINAL_STAGES)));
}

/** Add business days (Fri/Sat weekend is NOT assumed — UAE private sector uses Sat/Sun). */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}
