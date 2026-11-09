import { and, desc, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  accountOwners,
  companies,
  contacts,
  followUps,
  interactions,
  leadEvidence,
  leads,
  meetings,
  opportunities,
  reports,
} from "@/lib/db/schema";
import { generateStructured } from "@/lib/ai/router";
import { assignLead } from "@/lib/domain/assignment";
import { requestApproval } from "@/lib/domain/approvals";
import { getEmployee, getEmployeeByRole, listSalesExecutives } from "@/lib/domain/employees";
import { salesExecDashboard } from "@/lib/domain/kpi";
import { getKnowledge, knowledgeAsPrompt } from "@/lib/domain/knowledge";
import { recall, remember } from "@/lib/domain/memory";
import { sendMessage } from "@/lib/domain/messaging";
import { addBusinessDays, scheduleFollowUp, stageIndex, stageLabel, TERMINAL_STAGES, transitionOpportunity, type Stage } from "@/lib/domain/pipeline";
import { createTask } from "@/lib/domain/tasks";
import type { Skill } from "../types";
import { NonRetryableError } from "../types";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// ───────────────────────── Sales Director ─────────────────────────

export const leadAssign: Skill = {
  type: "lead.assign",
  label: "Assign qualified leads",
  office: { status: "working", location: "sales_department" },
  async run({ db, task, actor, progress }) {
    const leadId = str(task.input.leadId);
    const ids = leadId
      ? [leadId]
      : (await db.select({ id: leads.id }).from(leads).where(eq(leads.status, "qualified")).orderBy(desc(leads.score))).map((r) => r.id);
    if (ids.length === 0) return { status: "completed", summary: "No qualified leads waiting for assignment." };
    const results = [];
    for (const [i, id] of ids.entries()) {
      const r = await assignLead(db, id, actor, { parentTaskId: task.id });
      results.push({ leadId: id, ...r });
      await progress(((i + 1) / ids.length) * 100);
    }
    const newly = results.filter((r) => !r.alreadyAssigned);
    return {
      status: "completed",
      summary: newly.length
        ? `Assigned ${newly.length} lead(s): ${newly.map((r) => ("employeeName" in r ? r.employeeName : "")).join(", ")}`
        : "Leads were already assigned.",
      output: { results },
    };
  },
};

/**
 * Daily pipeline control: every active opportunity must have a dated next action; overdue items
 * are flagged to the owner and escalated to the CGO after 3 days; stalled deals are flagged;
 * quotations without a scheduled follow-up get one.
 */
export const pipelineReview: Skill = {
  type: "pipeline.review",
  label: "Review pipeline & follow-ups",
  office: { status: "analyzing", location: "sales_department" },
  async run({ db, task, employee, actor }) {
    const now = new Date();
    const active = await db.select().from(opportunities).where(notInArray(opportunities.stage, TERMINAL_STAGES));
    const findings: { opportunityId: string; title: string; owner: string; issue: string }[] = [];
    const escalations: string[] = [];
    const staleCutoff = new Date(now.getTime() - 14 * 86400_000);
    const cgo = await getEmployeeByRole(db, "cgo");
    const byOwner = new Map<string, typeof findings>();
    for (const o of active) {
      const issues: string[] = [];
      if (!o.nextAction || !o.nextActionDue) issues.push("no next action / due date");
      else if (o.nextActionDue < now) {
        const daysOver = Math.floor((now.getTime() - o.nextActionDue.getTime()) / 86400_000);
        issues.push(`next action overdue by ${daysOver} day(s): "${o.nextAction}"`);
        if (daysOver >= 3) escalations.push(`${o.title} — next action ${daysOver} days overdue`);
      }
      if (o.lastActivityAt < staleCutoff) issues.push("no activity for 14+ days (stalled)");
      if (o.stage === "quotation_sent") {
        const [f] = await db
          .select({ id: followUps.id })
          .from(followUps)
          .where(and(eq(followUps.opportunityId, o.id), eq(followUps.status, "pending")))
          .limit(1);
        if (!f) {
          await scheduleFollowUp(db, o.id, addBusinessDays(now, 2), "Follow up on submitted quotation", actor);
          issues.push("quotation had no follow-up scheduled — scheduled in 2 business days");
        }
      }
      for (const issue of issues) {
        const owner = await getEmployee(db, o.ownerEmployeeId);
        const f = { opportunityId: o.id, title: o.title, owner: owner.name, issue };
        findings.push(f);
        byOwner.set(o.ownerEmployeeId, [...(byOwner.get(o.ownerEmployeeId) ?? []), f]);
      }
    }
    // Due follow-ups → the owner prepares the follow-up message (drafted, then approved).
    const due = await db
      .select()
      .from(followUps)
      .where(and(eq(followUps.status, "pending"), lt(followUps.dueAt, new Date(now.getTime() + 86400_000))));
    let followUpTasks = 0;
    for (const f of due) {
      const r = await createTask(db, {
        type: "followup.prepare",
        title: `Prepare follow-up: ${f.purpose}`,
        assigneeEmployeeId: f.ownerEmployeeId,
        createdBy: actor,
        parentTaskId: task.id,
        relatedType: "opportunity",
        relatedId: f.opportunityId,
        priority: f.dueAt < now ? 8 : 6,
        input: { followUpId: f.id, opportunityId: f.opportunityId },
        dedupeKey: `followup:${f.id}`,
      });
      if (r.created) followUpTasks++;
    }
    for (const [ownerId, items] of byOwner) {
      await sendMessage(db, {
        fromEmployeeId: employee.id,
        toEmployeeId: ownerId,
        kind: "message",
        subject: `Pipeline review: ${items.length} item(s) need your attention`,
        body: items.map((i) => `• ${i.title}: ${i.issue}`).join("\n") + "\nPlease update next actions today.",
        taskId: task.id,
      });
    }
    if (escalations.length) {
      await sendMessage(db, {
        fromEmployeeId: employee.id,
        toEmployeeId: cgo.id,
        kind: "escalation",
        subject: `Escalation: ${escalations.length} opportunity(ies) overdue 3+ days`,
        body: escalations.map((e) => `• ${e}`).join("\n"),
        taskId: task.id,
      });
    }
    const data = { activeOpportunities: active.length, findings, escalations, followUpTasksCreated: followUpTasks };
    await db.insert(reports).values({
      kind: "pipeline_review",
      title: `Pipeline review ${now.toISOString().slice(0, 10)}`,
      periodEnd: now,
      data,
      authorEmployeeId: employee.id,
      taskId: task.id,
    });
    return {
      status: "completed",
      summary: `Reviewed ${active.length} active opportunities: ${findings.length} issue(s), ${escalations.length} escalation(s), ${followUpTasks} follow-up task(s).`,
      output: data,
    };
  },
};

export const salesReviewMeeting: Skill = {
  type: "meeting.sales_review",
  label: "Weekly sales performance review",
  office: { status: "in_meeting", location: "meeting_room" },
  async run({ db, task, employee }) {
    const execs = await listSalesExecutives(db);
    const rows = [];
    for (const e of execs) rows.push({ name: e.name, id: e.id, ...(await salesExecDashboard(db, e.id)) });
    const [m] = await db
      .insert(meetings)
      .values({
        kind: "sales_review",
        title: `Weekly sales review — ${new Date().toISOString().slice(0, 10)}`,
        status: "completed",
        scheduledFor: new Date(),
        startedAt: new Date(),
        endedAt: new Date(),
        attendeeEmployeeIds: [employee.id, ...execs.map((e) => e.id)],
        agenda: ["Pipeline by executive", "Overdue follow-ups", "Deals requiring attention", "Wins and losses"],
        minutes: rows
          .map(
            (r) =>
              `${r.name}: ${r.activeOpportunities} active, ${r.rfqsReceived} RFQs, ${r.quotationsSubmitted} quotations, ${r.wonDeals} won / ${r.lostDeals} lost, ${r.overdueFollowUps} overdue follow-ups, ${r.dealsRequiringAttention.length} deals need attention.`,
          )
          .join("\n"),
        taskId: task.id,
      })
      .returning();
    for (const r of rows) {
      if (r.dealsRequiringAttention.length || r.overdueFollowUps) {
        await sendMessage(db, {
          fromEmployeeId: employee.id,
          toEmployeeId: r.id,
          kind: "task_assignment",
          subject: "Action items from weekly sales review",
          body: `${r.overdueFollowUps} overdue follow-up(s). Deals needing attention:\n${r.dealsRequiringAttention.map((d) => `• ${d.title} (${stageLabel(d.stage)}): ${d.reason}`).join("\n") || "none"}\nPlease update me by tomorrow.`,
          relatedType: "meeting",
          relatedId: m.id,
        });
      }
    }
    return { status: "completed", summary: `Sales review held with ${execs.length} executives.`, output: { meetingId: m.id, rows } };
  },
};

// ───────────────────────── Sales Executives ─────────────────────────

async function loadAccount(db: import("@/lib/db/types").DB, opportunityId: string) {
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp) throw new NonRetryableError(`Opportunity ${opportunityId} not found`);
  const [company] = await db.select().from(companies).where(eq(companies.id, opp.companyId));
  const cts = await db.select().from(contacts).where(eq(contacts.companyId, company.id));
  const [lead] = opp.leadId ? await db.select().from(leads).where(eq(leads.id, opp.leadId)) : [];
  const evidence = lead ? await db.select().from(leadEvidence).where(eq(leadEvidence.leadId, lead.id)) : [];
  const history = await db
    .select()
    .from(interactions)
    .where(eq(interactions.companyId, company.id))
    .orderBy(desc(interactions.occurredAt))
    .limit(20);
  return { opp, company, contacts: cts, lead, evidence, history };
}

/** A Sales Executive takes ownership: reviews the profile, builds an account plan, sets next action. */
export const opportunityOnboard: Skill = {
  type: "opportunity.onboard",
  label: "Onboard newly assigned account",
  office: { status: "working", location: "desk" },
  async run({ db, task, employee, actor }) {
    const opportunityId = str(task.input.opportunityId);
    if (!opportunityId) throw new NonRetryableError("opportunityId missing");
    const a = await loadAccount(db, opportunityId);
    if (a.opp.ownerEmployeeId !== employee.id) throw new NonRetryableError("Only the account owner may onboard this opportunity");
    const memories = await recall(db, employee.id, { type: "company", id: a.company.id });
    const dm = a.contacts.find((c) => c.isDecisionMaker) ?? a.contacts.find((c) => c.jobTitle);
    const gaps: string[] = [];
    if (!dm) gaps.push("decision-maker contact");
    if (dm && !dm.email && !dm.phone && !dm.linkedinUrl) gaps.push("a business contact channel for the decision-maker");
    if (!a.lead?.capacityKvaMin && !a.lead?.capacityKvaMax) gaps.push("indicative capacity (kVA)");
    if (!a.lead?.purchaseTiming || a.lead.purchaseTiming === "unknown") gaps.push("purchase timing");
    const plan = {
      company: a.company.name,
      evidenceItems: a.evidence.length,
      priorInteractions: a.history.length,
      memoriesConsulted: memories.length,
      decisionMaker: dm ? `${dm.name ?? "Unknown name"} — ${dm.jobTitle ?? "role unknown"}` : null,
      gaps,
    };
    await remember(db, {
      employeeId: employee.id,
      kind: "fact",
      subjectType: "company",
      subjectId: a.company.id,
      content: `Account plan: ${dm ? `target ${plan.decisionMaker}` : "decision-maker not yet identified"}. Gaps: ${gaps.join(", ") || "none"}.`,
      importance: 3,
      sourceTaskId: task.id,
    });
    const due = addBusinessDays(new Date(), 1);
    if (!dm) {
      await db
        .update(opportunities)
        .set({ nextAction: "Identify decision-maker (procurement / MEP / facilities)", nextActionDue: due, updatedAt: new Date() })
        .where(eq(opportunities.id, opportunityId));
      if (a.lead) {
        const researcher = await getEmployeeByRole(db, "lead_research_manager");
        await sendMessage(db, {
          fromEmployeeId: employee.id,
          toEmployeeId: researcher.id,
          kind: "information_request",
          subject: `Need decision-maker for ${a.company.name}`,
          body: `I own ${a.company.name}. Can you identify the procurement / MEP / facilities decision-maker from public sources?`,
          relatedType: "lead",
          relatedId: a.lead.id,
        });
        await createTask(db, {
          type: "lead.research",
          title: `Find decision-maker: ${a.company.name}`,
          assigneeEmployeeId: researcher.id,
          createdBy: actor,
          parentTaskId: task.id,
          relatedType: "lead",
          relatedId: a.lead.id,
          priority: 7,
          input: { leadId: a.lead.id, focus: "decision_maker", requestedBy: employee.id },
          dedupeKey: `research:lead:${a.lead.id}`,
        });
      }
      return { status: "completed", summary: `Account plan for ${a.company.name}: decision-maker research requested.`, output: plan };
    }
    await db
      .update(opportunities)
      .set({ nextAction: "Draft personalised initial outreach for approval", nextActionDue: due, updatedAt: new Date() })
      .where(eq(opportunities.id, opportunityId));
    await createTask(db, {
      type: "outreach.draft",
      title: `Draft initial outreach: ${a.company.name}`,
      assigneeEmployeeId: employee.id,
      createdBy: actor,
      parentTaskId: task.id,
      relatedType: "opportunity",
      relatedId: opportunityId,
      priority: 7,
      input: { opportunityId, contactId: dm.id, channel: dm.email ? "email" : "linkedin" },
      dedupeKey: `outreach:opp:${opportunityId}`,
    });
    return { status: "completed", summary: `Account plan for ${a.company.name} ready; drafting outreach to ${plan.decisionMaker}.`, output: plan };
  },
};

const DraftSchema = z.object({
  subject: z.string().describe("Email subject line (empty for LinkedIn)"),
  body: z.string().describe("Message body, plain text, signed by the sales executive"),
  rationale: z.string().describe("Why this angle fits this account, citing the evidence used"),
  claimsUsed: z.array(z.string()).describe("Every factual claim about 4U made in the message, each from VERIFIED COMPANY FACTS"),
  needsHumanInput: z.array(z.string()).describe("Anything you could not say because it is not verified (price, stock, lead time, specs)"),
});

const SALES_RULES = `You are an AI Sales Executive at 4U Power Generation FZC (SAIF Zone, Sharjah, UAE), a B2B diesel generator supplier/assembler.
Rules you must follow:
- Never state prices, discounts, stock availability, delivery dates, lead times or technical ratings unless they appear in VERIFIED COMPANY FACTS.
- Never invent company capabilities, certifications, references or customers.
- Do not claim to know the customer's requirement unless it is in the evidence; frame inferred needs as questions.
- Be concise, technical and professional (B2B, GCC business tone). No hype. One clear call to action.
- This is a DRAFT for human approval; it will not be sent automatically.`;

async function draftMessage(
  ctx: Parameters<Skill["run"]>[0],
  purpose: "initial_outreach" | "follow_up",
  opportunityId: string,
  extra: { feedback?: string; followUpPurpose?: string; contactId?: string; channel?: string },
) {
  const { db, task, employee } = ctx;
  const a = await loadAccount(db, opportunityId);
  if (a.opp.ownerEmployeeId !== employee.id) throw new NonRetryableError("Only the account owner may contact this customer");
  if (TERMINAL_STAGES.includes(a.opp.stage as Stage)) return { status: "completed" as const, summary: "Opportunity is closed — no message drafted." };
  const contact = a.contacts.find((c) => c.id === extra.contactId) ?? a.contacts.find((c) => c.isDecisionMaker) ?? a.contacts[0];
  if (!contact) return { status: "blocked" as const, reason: `No contact on file for ${a.company.name}. Add a contact or let research identify one.` };
  const channel = extra.channel === "linkedin" || (!contact.email && contact.linkedinUrl) ? "linkedin" : "email";
  const kb = await getKnowledge(db, ["company_profile", "product_catalogue", "policy"]);
  const memories = await recall(db, employee.id, { type: "company", id: a.company.id });
  await ctx.progress(30, "Drafting message");
  const prompt = `TASK: Draft a ${purpose === "initial_outreach" ? "first outreach" : "follow-up"} ${channel} message.
${extra.followUpPurpose ? `FOLLOW-UP PURPOSE: ${extra.followUpPurpose}\n` : ""}${extra.feedback ? `APPROVER FEEDBACK ON PREVIOUS DRAFT (must address): ${extra.feedback}\n` : ""}
SENDER: ${employee.name}, ${employee.title}, 4U Power Generation FZC.
RECIPIENT: ${contact.name ?? "(name unknown — use a role-appropriate greeting)"}, ${contact.jobTitle ?? "role unknown"} at ${a.company.name}.
ACCOUNT: ${a.company.name}; industry ${a.company.industry ?? "unknown"}; ${a.company.city ?? ""} ${a.company.country ?? ""}; activity: ${a.company.businessActivity ?? "unknown"}.
OPPORTUNITY: ${a.opp.title}; stage ${stageLabel(a.opp.stage)}; capacity ${a.opp.capacityKva ?? "unknown"} kVA; brand preference ${a.opp.brandPreference ?? "none stated"}.
LEAD SIGNAL: ${a.lead?.buyingSignal ?? a.lead?.requirementSummary ?? "none recorded"} (${a.lead?.signalStrength ?? "n/a"}).
EVIDENCE:
${a.evidence.map((e) => `- ${e.title} (${e.url}): ${e.excerpt ?? ""}`).join("\n") || "(none)"}
COMMUNICATION HISTORY (newest first):
${a.history.map((h) => `- ${h.occurredAt.toISOString().slice(0, 10)} ${h.direction} ${h.channel} [${h.status}]: ${h.subject ?? ""} ${(h.body ?? "").slice(0, 300)}`).join("\n") || "(none)"}
MY ACCOUNT MEMORY:
${memories.map((m) => `- (${m.kind}) ${m.content}`).join("\n") || "(none)"}
${knowledgeAsPrompt(kb)}`;
  const draft = await generateStructured(
    { db, employeeId: employee.id, taskId: task.id },
    { profile: "sales_writing", system: `${SALES_RULES}\nYour persona: ${employee.persona}`, prompt, schema: DraftSchema },
  );
  await ctx.progress(70, "Submitting for approval");
  const [ix] = await db
    .insert(interactions)
    .values({
      opportunityId,
      companyId: a.company.id,
      contactId: contact.id,
      employeeId: employee.id,
      channel,
      direction: "outbound",
      status: "pending_approval",
      subject: draft.subject || null,
      body: draft.body,
    })
    .returning();
  const due = addBusinessDays(new Date(), 1);
  const idx = stageIndex(a.opp.stage as Stage);
  if (purpose === "initial_outreach" && idx < stageIndex("initial_contact_drafted")) {
    await transitionOpportunity(db, opportunityId, "initial_contact_drafted", ctx.actor, { note: "Outreach drafted", nextAction: "Outreach awaiting human approval", nextActionDue: due });
  }
  if (purpose === "initial_outreach" && stageIndex(a.opp.stage as Stage) <= stageIndex("initial_contact_drafted")) {
    await transitionOpportunity(db, opportunityId, "awaiting_approval", ctx.actor, { note: "Submitted for approval", nextAction: "Outreach awaiting human approval", nextActionDue: due });
  }
  const approval = await requestApproval(db, {
    action: channel === "email" ? "send_external_email" : "send_linkedin_message",
    title: `${purpose === "initial_outreach" ? "Outreach" : "Follow-up"} to ${contact.name ?? contact.jobTitle ?? "contact"} at ${a.company.name}`,
    summary: `${employee.name} drafted a ${channel} message. Rationale: ${draft.rationale}${draft.needsHumanInput.length ? ` | Needs human input: ${draft.needsHumanInput.join("; ")}` : ""}`,
    payload: {
      interactionId: ix.id,
      channel,
      toEmail: contact.email ?? null,
      toEmailStatus: contact.emailStatus,
      claimsUsed: draft.claimsUsed,
      needsHumanInput: draft.needsHumanInput,
    },
    requestedByEmployeeId: employee.id,
    taskId: task.id,
    relatedType: "opportunity",
    relatedId: opportunityId,
  });
  await db.update(interactions).set({ approvalId: approval.id }).where(eq(interactions.id, ix.id));
  if (extra.feedback) {
    await remember(db, { employeeId: employee.id, kind: "lesson", subjectType: "company", subjectId: a.company.id, content: `Approver feedback on outreach: ${extra.feedback}`, importance: 4, sourceTaskId: task.id });
  }
  return {
    status: "waiting_approval" as const,
    approvalId: approval.id,
    summary: `Drafted ${channel} to ${a.company.name}; awaiting approval.`,
    output: { interactionId: ix.id, subject: draft.subject, rationale: draft.rationale, needsHumanInput: draft.needsHumanInput },
  };
}

export const outreachDraft: Skill = {
  type: "outreach.draft",
  label: "Draft outreach message",
  office: { status: "writing", location: "desk" },
  requires: ["anthropic"],
  async run(ctx) {
    const opportunityId = str(ctx.task.input.opportunityId);
    if (!opportunityId) throw new NonRetryableError("opportunityId missing");
    return draftMessage(ctx, "initial_outreach", opportunityId, {
      feedback: str(ctx.task.input.feedback),
      contactId: str(ctx.task.input.contactId),
      channel: str(ctx.task.input.channel),
    });
  },
};

export const followUpPrepare: Skill = {
  type: "followup.prepare",
  label: "Prepare follow-up message",
  office: { status: "contacting_customer", location: "desk" },
  requires: ["anthropic"],
  async run(ctx) {
    const followUpId = str(ctx.task.input.followUpId);
    const [f] = followUpId ? await ctx.db.select().from(followUps).where(eq(followUps.id, followUpId)) : [];
    if (!f) throw new NonRetryableError("Follow-up not found");
    if (f.status !== "pending") return { status: "completed", summary: `Follow-up already ${f.status}.` };
    const res = await draftMessage(ctx, "follow_up", f.opportunityId, { followUpPurpose: f.purpose, feedback: str(ctx.task.input.feedback) });
    return res;
  },
};

/** Used by UI to list accounts an executive owns (with no-owner safety check). */
export async function accountsWithoutNextAction(db: import("@/lib/db/types").DB) {
  return db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(notInArray(opportunities.stage, TERMINAL_STAGES), or(isNull(opportunities.nextAction), isNull(opportunities.nextActionDue))));
}

export async function ownerOf(db: import("@/lib/db/types").DB, companyId: string) {
  const [o] = await db.select().from(accountOwners).where(eq(accountOwners.companyId, companyId));
  return o ?? null;
}
