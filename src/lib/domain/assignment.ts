import { and, eq, notInArray, sql, lt } from "drizzle-orm";
import {
  accountOwners,
  agentMemories,
  companies,
  followUps,
  leads,
  opportunities,
  ownershipHistory,
  stageTransitions,
} from "@/lib/db/schema";
import type { EmployeeSpecialization } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { logActivity, type Actor } from "./activity";
import { getEmployee, getEmployeeByRole, listSalesExecutives } from "./employees";
import { remember } from "./memory";
import { sendMessage } from "./messaging";
import { addBusinessDays, TERMINAL_STAGES } from "./pipeline";
import { createTask } from "./tasks";

export interface ExecCandidate {
  id: string;
  name: string;
  code: string;
  specialization: EmployeeSpecialization;
  openOpportunities: number;
  overdueFollowUps: number;
}

export interface LeadProfile {
  industry: string | null;
  accountType: string | null;
  capacityKvaMax: number | null;
  requirementSummary: string | null;
  score: number | null;
}

export interface AssignmentDecision {
  employeeId: string;
  name: string;
  reasons: string[];
  ranking: { name: string; points: number; reasons: string[] }[];
}

/**
 * Deterministic routing of a lead to ONE Sales Executive.
 *  + account-type match (40), industry match (30), complex/high-capacity match (35)
 *  − workload relative to capacity (up to 30), − 3 per overdue follow-up (discipline)
 *  Executives at or above max open opportunities are excluded unless everyone is full.
 *  Ties → fewer open opportunities → employee code.
 */
export function chooseSalesExecutive(lead: LeadProfile, execs: ExecCandidate[]): AssignmentDecision {
  if (execs.length === 0) throw new Error("No active Sales Executives available");
  const complex =
    (lead.capacityKvaMax ?? 0) >= 1000 || /synchron|parallel|multiple units|\bx\s*\d+ units?/i.test(lead.requirementSummary ?? "");
  const scored = execs.map((e) => {
    const s = e.specialization ?? {};
    const reasons: string[] = [];
    let pts = 0;
    const accountType = lead.accountType ?? (lead.industry === "generator_reseller" ? "reseller" : lead.industry === "mep_contractor" || lead.industry === "construction" ? "contractor" : null);
    if (accountType && s.accountTypes?.includes(accountType)) {
      pts += 40;
      reasons.push(`handles ${accountType.replace(/_/g, " ")} accounts`);
    }
    if (lead.industry && s.industries?.includes(lead.industry)) {
      pts += 30;
      reasons.push(`specialises in ${lead.industry.replace(/_/g, " ")}`);
    }
    if (complex && (s.minDealAed ?? 0) >= 250000 && /complex|high capacity|synchron/i.test(s.notes ?? "")) {
      pts += 35;
      reasons.push("handles complex / high-capacity projects");
    }
    const max = s.maxOpenOpportunities ?? 25;
    const load = e.openOpportunities / max;
    pts -= Math.round(load * 30);
    reasons.push(`workload ${e.openOpportunities}/${max}`);
    if (e.overdueFollowUps > 0) {
      pts -= 3 * e.overdueFollowUps;
      reasons.push(`${e.overdueFollowUps} overdue follow-up(s)`);
    }
    return { e, pts, reasons, full: e.openOpportunities >= max };
  });
  const pool = scored.some((x) => !x.full) ? scored.filter((x) => !x.full) : scored;
  pool.sort((a, b) => b.pts - a.pts || a.e.openOpportunities - b.e.openOpportunities || a.e.code.localeCompare(b.e.code));
  const winner = pool[0];
  return {
    employeeId: winner.e.id,
    name: winner.e.name,
    reasons: winner.reasons,
    ranking: scored
      .sort((a, b) => b.pts - a.pts)
      .map((x) => ({ name: x.e.name, points: x.pts, reasons: x.full ? [...x.reasons, "at capacity"] : x.reasons })),
  };
}

export async function loadExecCandidates(db: DB): Promise<ExecCandidate[]> {
  const execs = await listSalesExecutives(db);
  const out: ExecCandidate[] = [];
  for (const e of execs) {
    const [open] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(and(eq(opportunities.ownerEmployeeId, e.id), notInArray(opportunities.stage, TERMINAL_STAGES)));
    const [overdue] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(followUps)
      .where(and(eq(followUps.ownerEmployeeId, e.id), eq(followUps.status, "pending"), lt(followUps.dueAt, new Date())));
    out.push({
      id: e.id,
      name: e.name,
      code: e.code,
      specialization: e.specialization,
      openOpportunities: open?.n ?? 0,
      overdueFollowUps: overdue?.n ?? 0,
    });
  }
  return out;
}

export class AssignmentError extends Error {}

/**
 * Assign a qualified lead. Enforces the ownership rule: if the company already has an owner,
 * the opportunity goes to that owner — never to a second executive.
 */
export async function assignLead(
  db: DB,
  leadId: string,
  actor: Actor,
  opts: { overrideEmployeeId?: string; reason?: string; parentTaskId?: string } = {},
) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) throw new AssignmentError("Lead not found");
  if (lead.status === "assigned") {
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.leadId, leadId));
    return { alreadyAssigned: true as const, opportunityId: opp?.id ?? null, employeeId: opp?.ownerEmployeeId ?? null };
  }
  if (lead.status !== "qualified" && !(actor.type === "user" && opts.overrideEmployeeId)) {
    throw new AssignmentError(`Only qualified leads can be assigned automatically (lead is ${lead.status}).`);
  }
  if (lead.status === "duplicate" || lead.status === "rejected") throw new AssignmentError(`Lead is ${lead.status}`);
  const [company] = await db.select().from(companies).where(eq(companies.id, lead.companyId));

  let decision: AssignmentDecision | null = null;
  let chosenId: string;
  let reason: string;
  const [existingOwner] = await db.select().from(accountOwners).where(eq(accountOwners.companyId, company.id));
  if (existingOwner) {
    chosenId = existingOwner.ownerEmployeeId;
    reason = "Existing account owner retains the account (single-ownership rule).";
  } else if (opts.overrideEmployeeId) {
    const target = await getEmployee(db, opts.overrideEmployeeId);
    if (!target.isSalesExecutive) throw new AssignmentError("Leads can only be assigned to Sales Executives.");
    chosenId = target.id;
    reason = opts.reason?.trim() || "Manual assignment";
  } else {
    decision = chooseSalesExecutive(
      {
        industry: company.industry,
        accountType: company.accountType,
        capacityKvaMax: lead.capacityKvaMax,
        requirementSummary: lead.requirementSummary,
        score: lead.score,
      },
      await loadExecCandidates(db),
    );
    chosenId = decision.employeeId;
    reason = `Routing: ${decision.reasons.join("; ")}`;
  }

  const now = new Date();
  const due = addBusinessDays(now, 1);
  const cap = lead.capacityKvaMax ?? lead.capacityKvaMin;
  const title = `${cap ? `${lead.capacityKvaMin && lead.capacityKvaMax && lead.capacityKvaMin !== lead.capacityKvaMax ? `${lead.capacityKvaMin}–${lead.capacityKvaMax}` : cap} kVA ` : ""}generator opportunity — ${company.name}`;

  const opportunityId = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    if (!existingOwner) {
      const inserted = await tx
        .insert(accountOwners)
        .values({
          companyId: company.id,
          ownerEmployeeId: chosenId,
          assignedByEmployeeId: actor.type === "agent" ? actor.id : null,
          assignedByUserId: actor.type === "user" ? actor.id : null,
          reason,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        // Concurrent assignment won the race — respect it.
        const [o] = await tx.select().from(accountOwners).where(eq(accountOwners.companyId, company.id));
        chosenId = o.ownerEmployeeId;
        reason = "Existing account owner retains the account (single-ownership rule).";
      } else {
        await tx.insert(ownershipHistory).values({
          companyId: company.id,
          fromEmployeeId: null,
          toEmployeeId: chosenId,
          reason,
          changedByType: actor.type,
          changedById: actor.id ?? null,
        });
      }
    }
    const [opp] = await tx
      .insert(opportunities)
      .values({
        companyId: company.id,
        leadId,
        ownerEmployeeId: chosenId,
        title,
        stage: "qualified",
        capacityKva: cap ?? null,
        brandPreference: lead.brandPreference,
        probability: 10,
        valueIsEstimate: true,
        nextAction: "Review account and prepare personalised outreach strategy",
        nextActionDue: due,
      })
      .returning();
    await tx.insert(stageTransitions).values({
      opportunityId: opp.id,
      fromStage: null,
      toStage: "qualified",
      actorType: actor.type,
      actorId: actor.id ?? null,
      note: `Created from lead (score ${lead.score ?? "n/a"}). ${reason}`,
    });
    await tx.update(leads).set({ status: "assigned", updatedAt: now }).where(eq(leads.id, leadId));
    return opp.id;
  });

  const exec = await getEmployee(db, chosenId);
  const director = await getEmployeeByRole(db, "sales_director");
  await sendMessage(db, {
    fromEmployeeId: actor.type === "agent" ? actor.id : director.id,
    fromUserId: actor.type === "user" ? actor.id : null,
    toEmployeeId: exec.id,
    kind: "task_assignment",
    subject: `New account assigned: ${company.name}`,
    body: `${exec.name}, ${company.name} is now your account (lead score ${lead.score ?? "n/a"}/100). ${lead.requirementSummary ?? ""} Reason: ${reason}. Please prepare the outreach strategy and update me by ${due.toISOString().slice(0, 10)}.`,
    relatedType: "opportunity",
    relatedId: opportunityId,
  });
  await sendMessage(db, {
    fromEmployeeId: exec.id,
    toEmployeeId: director.id,
    kind: "acknowledgement",
    subject: `Re: New account assigned: ${company.name}`,
    body: `I have received the ${company.name} account. I am reviewing the research profile and preparing the outreach strategy.`,
    relatedType: "opportunity",
    relatedId: opportunityId,
  });
  await remember(db, {
    employeeId: exec.id,
    kind: "assignment",
    subjectType: "company",
    subjectId: company.id,
    content: `I own ${company.name}${company.country ? ` (${company.country})` : ""}. Opportunity: ${title}. Lead score ${lead.score ?? "n/a"}. Assigned because: ${reason}`,
    importance: 4,
  });
  await logActivity(db, actor, "lead.assigned", `${company.name} assigned to ${exec.name}`, {
    entityType: "opportunity",
    entityId: opportunityId,
    detail: { leadId, employeeId: exec.id, reason, ranking: decision?.ranking ?? null },
  });
  await createTask(db, {
    type: "opportunity.onboard",
    title: `Onboard account: ${company.name}`,
    assigneeEmployeeId: exec.id,
    createdBy: actor,
    parentTaskId: opts.parentTaskId ?? null,
    relatedType: "opportunity",
    relatedId: opportunityId,
    priority: (lead.score ?? 0) >= 80 ? 8 : 6,
    input: { opportunityId },
    dedupeKey: `onboard:opp:${opportunityId}`,
  });
  return { alreadyAssigned: false as const, opportunityId, employeeId: exec.id, employeeName: exec.name, reason, ranking: decision?.ranking ?? null };
}

/** Formal reassignment by the Sales Director or a sales manager. Requires a recorded reason. */
export async function reassignAccount(db: DB, companyId: string, toEmployeeId: string, reason: string, actor: Actor) {
  if (!reason?.trim()) throw new AssignmentError("Reassignment requires a reason.");
  const [current] = await db.select().from(accountOwners).where(eq(accountOwners.companyId, companyId));
  if (!current) throw new AssignmentError("Company has no owner yet — assign its lead instead.");
  if (current.ownerEmployeeId === toEmployeeId) throw new AssignmentError("Already owned by this executive.");
  const target = await getEmployee(db, toEmployeeId);
  if (!target.isSalesExecutive) throw new AssignmentError("Accounts can only be owned by Sales Executives.");
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const from = await getEmployee(db, current.ownerEmployeeId);

  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    await tx
      .update(accountOwners)
      .set({
        ownerEmployeeId: toEmployeeId,
        assignedAt: new Date(),
        reason,
        assignedByEmployeeId: actor.type === "agent" ? actor.id : null,
        assignedByUserId: actor.type === "user" ? actor.id : null,
      })
      .where(eq(accountOwners.companyId, companyId));
    await tx.insert(ownershipHistory).values({
      companyId,
      fromEmployeeId: from.id,
      toEmployeeId,
      reason,
      changedByType: actor.type,
      changedById: actor.id ?? null,
    });
    const openOpps = await tx
      .update(opportunities)
      .set({ ownerEmployeeId: toEmployeeId, updatedAt: new Date() })
      .where(and(eq(opportunities.companyId, companyId), notInArray(opportunities.stage, TERMINAL_STAGES)))
      .returning({ id: opportunities.id });
    for (const o of openOpps) {
      await tx
        .update(followUps)
        .set({ ownerEmployeeId: toEmployeeId })
        .where(and(eq(followUps.opportunityId, o.id), eq(followUps.status, "pending")));
    }
    // Hand over the previous owner's account memory so context is preserved.
    const mem = await tx
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.employeeId, from.id), eq(agentMemories.subjectType, "company"), eq(agentMemories.subjectId, companyId)));
    for (const m of mem) {
      await tx.insert(agentMemories).values({
        employeeId: toEmployeeId,
        kind: m.kind,
        subjectType: "company",
        subjectId: companyId,
        content: `[Handover from ${from.name}] ${m.content}`,
        importance: m.importance,
      });
    }
  });
  await sendMessage(db, {
    fromEmployeeId: actor.type === "agent" ? actor.id : null,
    fromUserId: actor.type === "user" ? actor.id : null,
    toEmployeeId,
    kind: "task_assignment",
    subject: `Account reassigned to you: ${company.name}`,
    body: `${company.name} has been reassigned from ${from.name} to you. Reason: ${reason}. Full communication history and ${from.name}'s account notes are attached to the account.`,
    relatedType: "company",
    relatedId: companyId,
  });
  await sendMessage(db, {
    fromEmployeeId: actor.type === "agent" ? actor.id : null,
    fromUserId: actor.type === "user" ? actor.id : null,
    toEmployeeId: from.id,
    kind: "message",
    subject: `Account reassigned: ${company.name}`,
    body: `${company.name} is now owned by ${target.name}. Reason: ${reason}.`,
    relatedType: "company",
    relatedId: companyId,
  });
  await logActivity(db, actor, "account.reassigned", `${company.name} reassigned ${from.name} → ${target.name}`, {
    entityType: "company",
    entityId: companyId,
    detail: { reason, from: from.id, to: toEmployeeId },
  });
}
