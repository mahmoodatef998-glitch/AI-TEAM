import { and, avg, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { aiEmployees, approvals, leads, meetings, opportunities, reports, tasks } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { getEmployeeByRole, listSalesExecutives } from "@/lib/domain/employees";
import {
  buildKpiPlan,
  conversionRates,
  currentRevenueTarget,
  funnelMetrics,
  monthKey,
  operationalCounts,
  pipelineSnapshot,
  salesExecDashboard,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "@/lib/domain/kpi";
import { sendMessage } from "@/lib/domain/messaging";
import type { Skill } from "../types";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export const kpiPlan: Skill = {
  type: "kpi.plan",
  label: "Translate revenue target into KPIs",
  office: { status: "analyzing", location: "executive_office" },
  async run({ db, task, employee }) {
    const period = monthKey();
    const target = await currentRevenueTarget(db, period);
    if (!target) {
      return {
        status: "blocked",
        reason: `No closed-revenue target is set for ${period}. Management must set it on the Executive dashboard (Settings → Targets) — the CGO will not invent a target.`,
      };
    }
    const rates = await conversionRates(db);
    const plan = buildKpiPlan(target.value, rates);
    const monthSoFar = await funnelMetrics(db, startOfMonth(), new Date());
    const data = { period, targetAed: target.value, targetIsAssumption: target.isAssumption, rates, plan, monthToDate: monthSoFar };
    await db.insert(reports).values({
      kind: "kpi_plan",
      title: `KPI plan ${period}: AED ${fmt(target.value)}`,
      periodStart: startOfMonth(),
      data,
      authorEmployeeId: employee.id,
      taskId: task.id,
    });
    const assumptionNote = plan.some((p) => p.basis !== "historical")
      ? "\nNOTE: some figures are based on INITIAL ASSUMPTIONS (insufficient closed-deal history). Replace with 4U actuals when available."
      : "";
    const lines = plan.map((p) => `• ${p.metric}: ${p.required} (${p.basis}; ${p.formula})`).join("\n");
    for (const role of ["sales_director", "lead_research_manager", "marketing_director"]) {
      const to = await getEmployeeByRole(db, role);
      await sendMessage(db, {
        fromEmployeeId: employee.id,
        toEmployeeId: to.id,
        kind: "task_assignment",
        subject: `${period} objectives — target AED ${fmt(target.value)}`,
        body: `To reach AED ${fmt(target.value)} closed revenue this month we need:\n${lines}\nMonth to date: ${monthSoFar.wonDeals} won (AED ${fmt(monthSoFar.wonValueAed)}), ${monthSoFar.quotationsSent} quotations, ${monthSoFar.rfqsReceived} RFQs, ${monthSoFar.qualifiedLeads} qualified leads.${assumptionNote}`,
        taskId: task.id,
      });
    }
    return { status: "completed", summary: `KPI plan for ${period} distributed to department heads.`, output: data };
  },
};

async function blockersSummary(db: DB) {
  const blocked = await db
    .select({ title: tasks.title, reason: tasks.blockedReason, assignee: aiEmployees.name })
    .from(tasks)
    .innerJoin(aiEmployees, eq(aiEmployees.id, tasks.assigneeEmployeeId))
    .where(eq(tasks.status, "blocked"))
    .orderBy(desc(tasks.updatedAt))
    .limit(20);
  return blocked;
}

export const dailyBriefing: Skill = {
  type: "briefing.daily",
  label: "09:00 executive briefing",
  office: { status: "in_meeting", location: "executive_office" },
  async run({ db, task, employee }) {
    const now = new Date();
    const yesterday = new Date(startOfDay(now).getTime() - 86400_000);
    const y = await funnelMetrics(db, yesterday, startOfDay(now));
    const mtd = await funnelMetrics(db, startOfMonth(now), now);
    const pipe = await pipelineSnapshot(db);
    const ops = await operationalCounts(db);
    const target = await currentRevenueTarget(db, monthKey(now));
    const [unassigned] = await db.select({ c: sql<number>`count(*)::int` }).from(leads).where(eq(leads.status, "qualified"));
    const blockers = await blockersSummary(db);
    const oldestApprovals = await db
      .select({ title: approvals.title, createdAt: approvals.createdAt })
      .from(approvals)
      .where(eq(approvals.status, "pending"))
      .orderBy(approvals.createdAt)
      .limit(5);
    const priorities: string[] = [];
    if (ops.pendingApprovals) priorities.push(`${ops.pendingApprovals} item(s) waiting for human approval — oldest: ${oldestApprovals[0]?.title ?? ""}`);
    if (unassigned?.c) priorities.push(`${unassigned.c} qualified lead(s) not yet assigned`);
    if (blockers.length) priorities.push(`${blockers.length} task(s) blocked on missing inputs/integrations`);
    if (!target) priorities.push(`No revenue target set for ${monthKey(now)}`);
    const data = { yesterday: y, monthToDate: mtd, pipeline: pipe, operations: ops, target, priorities, blockers };
    await db.insert(reports).values({
      kind: "daily_briefing",
      title: `Executive briefing ${now.toISOString().slice(0, 10)}`,
      periodStart: yesterday,
      periodEnd: now,
      data,
      authorEmployeeId: employee.id,
      taskId: task.id,
    });
    const body = `Yesterday: ${y.leadsCreated} leads (${y.qualifiedLeads} qualified), ${y.opportunitiesCreated} opportunities, ${y.rfqsReceived} RFQs, ${y.quotationsSent} quotations, ${y.wonDeals} won.
Month to date: AED ${fmt(mtd.wonValueAed)} won${target ? ` of AED ${fmt(target.value)} target (${((mtd.wonValueAed / target.value) * 100).toFixed(1)}%)` : " (no target set)"}.
Active pipeline: ${pipe.activeCount} opportunities${pipe.activeWithoutValue ? `, ${pipe.activeWithoutValue} without a value estimate` : ""}.
Today's priorities:\n${priorities.map((p) => `• ${p}`).join("\n") || "• No blockers."}`;
    for (const role of ["sales_director", "lead_research_manager", "marketing_director", "business_analyst"]) {
      const to = await getEmployeeByRole(db, role);
      await sendMessage(db, { fromEmployeeId: employee.id, toEmployeeId: to.id, kind: "report", subject: "Daily executive briefing", body, taskId: task.id });
    }
    return { status: "completed", summary: `Briefing issued: ${priorities.length} priority item(s).`, output: data };
  },
};

export const dailyPerformanceReport: Skill = {
  type: "report.daily_performance",
  label: "17:00 daily performance report",
  office: { status: "analyzing", location: "research_department" },
  async run({ db, task, employee }) {
    const now = new Date();
    const today = await funnelMetrics(db, startOfDay(now), now);
    const week = await funnelMetrics(db, startOfWeek(now), now);
    const execs = await listSalesExecutives(db);
    const perExec = [];
    for (const e of execs) {
      const d = await salesExecDashboard(db, e.id);
      perExec.push({ name: e.name, active: d.activeOpportunities, overdue: d.overdueFollowUps, rfqs: d.rfqsReceived, quotations: d.quotationsSubmitted, won: d.wonDeals, attention: d.dealsRequiringAttention.length });
    }
    const [q] = await db
      .select({ avgScore: avg(leads.score), scored: sql<number>`count(${leads.score})::int` })
      .from(leads)
      .where(and(isNotNull(leads.score), gte(leads.createdAt, startOfWeek(now))));
    const ops = await operationalCounts(db);
    const recommendations: string[] = [];
    const overdueTotal = perExec.reduce((s, p) => s + p.overdue, 0);
    if (overdueTotal > 0) recommendations.push(`Clear ${overdueTotal} overdue follow-up(s) before new outreach.`);
    if (week.leadsCreated > 0 && week.qualifiedLeads / week.leadsCreated < 0.3) recommendations.push("Under 30% of this week's leads qualified — tighten discovery targeting toward evidenced projects/tenders.");
    if (ops.pendingApprovals > 5) recommendations.push(`${ops.pendingApprovals} approvals pending — approval latency is slowing outreach.`);
    const data = { today, week, perExec, leadQuality: { avgScoreThisWeek: q?.avgScore ? Number(q.avgScore) : null, scored: q?.scored ?? 0 }, operations: ops, recommendations, dataNote: "All figures are actual system counts. Revenue counts only won deals with a recorded actual value." };
    await db.insert(reports).values({ kind: "daily_performance", title: `Daily performance ${now.toISOString().slice(0, 10)}`, periodStart: startOfDay(now), periodEnd: now, data, authorEmployeeId: employee.id, taskId: task.id });
    const cgo = await getEmployeeByRole(db, "cgo");
    await sendMessage(db, {
      fromEmployeeId: employee.id,
      toEmployeeId: cgo.id,
      kind: "report",
      subject: `Daily performance report ${now.toISOString().slice(0, 10)}`,
      body: `Today: ${today.leadsCreated} leads, ${today.qualifiedLeads} qualified, ${today.rfqsReceived} RFQs, ${today.quotationsSent} quotations, ${today.wonDeals} won.\n${perExec.map((p) => `${p.name}: ${p.active} active, ${p.overdue} overdue, ${p.attention} need attention`).join("\n")}\n${recommendations.map((r) => `→ ${r}`).join("\n")}`,
      taskId: task.id,
    });
    return { status: "completed", summary: `Daily report: ${today.leadsCreated} leads, ${today.wonDeals} won, ${recommendations.length} recommendation(s).`, output: data };
  },
};

export const weeklyExecMeeting: Skill = {
  type: "meeting.weekly_exec",
  label: "Weekly executive management meeting",
  office: { status: "in_meeting", location: "meeting_room" },
  async run({ db, task, employee }) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400_000);
    const week = await funnelMetrics(db, weekAgo, now);
    const pipe = await pipelineSnapshot(db);
    const lostReasons = await db
      .select({ reason: opportunities.lostReason, c: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(and(eq(opportunities.stage, "lost"), gte(opportunities.closedAt, weekAgo)))
      .groupBy(opportunities.lostReason);
    const blockers = await blockersSummary(db);
    const heads = await db.select().from(aiEmployees).where(inArray(aiEmployees.roleKey, ["sales_director", "lead_research_manager", "marketing_director", "market_intelligence_analyst", "business_analyst"]));
    const minutes = [
      `Week: ${week.leadsCreated} leads (${week.qualifiedLeads} qualified), ${week.opportunitiesCreated} opportunities, ${week.rfqsReceived} RFQs, ${week.quotationsSent} quotations, ${week.wonDeals} won (AED ${fmt(week.wonValueAed)}), ${week.lostDeals} lost.`,
      `Active pipeline: ${pipe.activeCount} opportunities, AED ${fmt(pipe.activeValueAed)} estimated (${pipe.activeWithoutValue} without value).`,
      `Lost-deal reasons: ${lostReasons.map((l) => `${l.reason} (${l.c})`).join("; ") || "none this week"}.`,
      `Blockers: ${blockers.map((b) => `${b.assignee}: ${b.reason}`).slice(0, 8).join("; ") || "none"}.`,
    ].join("\n");
    const [m] = await db
      .insert(meetings)
      .values({
        kind: "weekly_exec",
        title: `Weekly executive meeting — ${now.toISOString().slice(0, 10)}`,
        status: "completed",
        scheduledFor: now,
        startedAt: now,
        endedAt: new Date(),
        attendeeEmployeeIds: [employee.id, ...heads.map((h) => h.id)],
        agenda: ["Weekly funnel", "Pipeline health", "Lost-deal analysis", "Lead quality", "Blockers", "Next week's plan"],
        minutes,
        taskId: task.id,
      })
      .returning();
    for (const h of heads) {
      await sendMessage(db, { fromEmployeeId: employee.id, toEmployeeId: h.id, kind: "report", subject: "Weekly executive meeting minutes", body: minutes, relatedType: "meeting", relatedId: m.id });
    }
    return { status: "completed", summary: "Weekly executive meeting held; minutes distributed.", output: { meetingId: m.id, minutes } };
  },
};
