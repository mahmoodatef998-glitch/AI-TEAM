import { and, eq, gte, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import {
  accountOwners,
  aiUsage,
  approvals,
  businessTargets,
  followUps,
  interactions,
  leads,
  opportunities,
  quotations,
  rfqs,
  stageTransitions,
  tasks,
} from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { TERMINAL_STAGES } from "./pipeline";

const n = (v: unknown) => Number(v ?? 0);

/**
 * Initial planning assumptions used ONLY when 4U has too little closed-deal history.
 * Every number derived from these is labelled "assumption" in reports and UI.
 */
export const DEFAULT_ASSUMPTIONS = {
  averageDealValueAed: 85000,
  quotationWinRate: 0.2,
  rfqToQuotationRate: 0.8,
  opportunityToRfqRate: 0.25,
  followUpsPerQuotation: 4,
  followUpsPerOpportunity: 2,
};

export interface FunnelMetrics {
  leadsCreated: number;
  qualifiedLeads: number;
  opportunitiesCreated: number;
  rfqsReceived: number;
  quotationsSent: number;
  quotationValueAed: number;
  wonDeals: number;
  wonValueAed: number;
  lostDeals: number;
}

export async function funnelMetrics(db: DB, from: Date, to: Date): Promise<FunnelMetrics> {
  const [l] = await db
    .select({
      created: sql<number>`count(*)::int`,
      qualified: sql<number>`count(*) filter (where ${leads.score} >= 60)::int`,
    })
    .from(leads)
    .where(and(gte(leads.createdAt, from), lt(leads.createdAt, to), notInArray(leads.status, ["duplicate"])));
  const [o] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(and(gte(opportunities.createdAt, from), lt(opportunities.createdAt, to)));
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(rfqs)
    .where(and(gte(rfqs.receivedAt, from), lt(rfqs.receivedAt, to)));
  const [q] = await db
    .select({ c: sql<number>`count(*)::int`, v: sql<string>`coalesce(sum(${quotations.totalAed}), 0)` })
    .from(quotations)
    .where(and(eq(quotations.status, "sent"), gte(quotations.sentAt, from), lt(quotations.sentAt, to)));
  const [qs] = await db
    .select({ c: sql<number>`count(distinct ${stageTransitions.opportunityId})::int` })
    .from(stageTransitions)
    .where(and(eq(stageTransitions.toStage, "quotation_sent"), gte(stageTransitions.createdAt, from), lt(stageTransitions.createdAt, to)));
  const [w] = await db
    .select({
      won: sql<number>`count(*) filter (where ${opportunities.stage} = 'won')::int`,
      wonValue: sql<string>`coalesce(sum(${opportunities.actualValueAed}) filter (where ${opportunities.stage} = 'won'), 0)`,
      lost: sql<number>`count(*) filter (where ${opportunities.stage} = 'lost')::int`,
    })
    .from(opportunities)
    .where(and(gte(opportunities.closedAt, from), lt(opportunities.closedAt, to)));
  return {
    leadsCreated: n(l?.created),
    qualifiedLeads: n(l?.qualified),
    opportunitiesCreated: n(o?.c),
    rfqsReceived: n(r?.c),
    quotationsSent: Math.max(n(q?.c), n(qs?.c)),
    quotationValueAed: n(q?.v),
    wonDeals: n(w?.won),
    wonValueAed: n(w?.wonValue),
    lostDeals: n(w?.lost),
  };
}

export async function pipelineSnapshot(db: DB) {
  const rows = await db
    .select({
      stage: opportunities.stage,
      c: sql<number>`count(*)::int`,
      value: sql<string>`coalesce(sum(${opportunities.expectedValueAed}), 0)`,
      withValue: sql<number>`count(${opportunities.expectedValueAed})::int`,
      estimated: sql<number>`count(*) filter (where ${opportunities.valueIsEstimate} and ${opportunities.expectedValueAed} is not null)::int`,
    })
    .from(opportunities)
    .groupBy(opportunities.stage);
  const active = rows.filter((r) => !TERMINAL_STAGES.includes(r.stage as never));
  return {
    byStage: rows.map((r) => ({ stage: r.stage, count: n(r.c), valueAed: n(r.value) })),
    activeCount: active.reduce((s, r) => s + n(r.c), 0),
    activeValueAed: active.reduce((s, r) => s + n(r.value), 0),
    activeWithoutValue: active.reduce((s, r) => s + (n(r.c) - n(r.withValue)), 0),
    activeValueEstimatedCount: active.reduce((s, r) => s + n(r.estimated), 0),
  };
}

export interface ConversionRates {
  averageDealValueAed: { value: number; basis: "historical" | "assumption"; sample: number };
  quotationWinRate: { value: number; basis: "historical" | "assumption"; sample: number };
  rfqToQuotationRate: { value: number; basis: "historical" | "assumption"; sample: number };
  opportunityToRfqRate: { value: number; basis: "historical" | "assumption"; sample: number };
}

/** Historical conversion rates where sample sizes are meaningful; otherwise labelled assumptions. */
export async function conversionRates(db: DB): Promise<ConversionRates> {
  const [won] = await db
    .select({ c: sql<number>`count(*)::int`, avg: sql<string>`avg(${opportunities.actualValueAed})` })
    .from(opportunities)
    .where(and(eq(opportunities.stage, "won"), sql`${opportunities.actualValueAed} is not null`));
  const reachedQuote = await db
    .selectDistinct({ id: stageTransitions.opportunityId })
    .from(stageTransitions)
    .where(eq(stageTransitions.toStage, "quotation_sent"));
  const quoteIds = reachedQuote.map((r) => r.id);
  let quotesDecided = 0;
  let quotesWon = 0;
  if (quoteIds.length) {
    const [d] = await db
      .select({
        decided: sql<number>`count(*) filter (where ${opportunities.stage} in ('won','lost'))::int`,
        won: sql<number>`count(*) filter (where ${opportunities.stage} = 'won')::int`,
      })
      .from(opportunities)
      .where(inArray(opportunities.id, quoteIds));
    quotesDecided = n(d?.decided);
    quotesWon = n(d?.won);
  }
  const [rfqOpps] = await db.select({ c: sql<number>`count(distinct ${rfqs.opportunityId})::int` }).from(rfqs);
  const [allOpps] = await db.select({ c: sql<number>`count(*)::int` }).from(opportunities);
  const [oldOpps] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(lte(opportunities.createdAt, new Date(Date.now() - 60 * 86400_000)));
  const A = DEFAULT_ASSUMPTIONS;
  return {
    averageDealValueAed:
      n(won?.c) >= 3
        ? { value: n(won?.avg), basis: "historical", sample: n(won?.c) }
        : { value: A.averageDealValueAed, basis: "assumption", sample: n(won?.c) },
    quotationWinRate:
      quotesDecided >= 5
        ? { value: quotesWon / quotesDecided, basis: "historical", sample: quotesDecided }
        : { value: A.quotationWinRate, basis: "assumption", sample: quotesDecided },
    rfqToQuotationRate:
      n(rfqOpps?.c) >= 5
        ? { value: Math.min(1, quoteIds.length / n(rfqOpps?.c)), basis: "historical", sample: n(rfqOpps?.c) }
        : { value: A.rfqToQuotationRate, basis: "assumption", sample: n(rfqOpps?.c) },
    opportunityToRfqRate:
      n(oldOpps?.c) >= 10
        ? { value: Math.min(1, n(rfqOpps?.c) / Math.max(1, n(allOpps?.c))), basis: "historical", sample: n(allOpps?.c) }
        : { value: A.opportunityToRfqRate, basis: "assumption", sample: n(allOpps?.c) },
  };
}

export interface KpiPlanLine {
  metric: string;
  required: number;
  basis: "historical" | "assumption" | "mixed";
  formula: string;
}

/** Reverse funnel: from a revenue target to required wins, quotations, RFQs, opportunities, follow-ups. */
export function buildKpiPlan(targetAed: number, rates: ConversionRates): KpiPlanLine[] {
  const b = (...bs: ("historical" | "assumption")[]) => (bs.every((x) => x === "historical") ? "historical" : bs.every((x) => x === "assumption") ? "assumption" : "mixed");
  const won = Math.ceil(targetAed / Math.max(1, rates.averageDealValueAed.value));
  const quotes = Math.ceil(won / Math.max(0.01, rates.quotationWinRate.value));
  const rfqsNeeded = Math.ceil(quotes / Math.max(0.01, rates.rfqToQuotationRate.value));
  const opps = Math.ceil(rfqsNeeded / Math.max(0.01, rates.opportunityToRfqRate.value));
  const follow = quotes * DEFAULT_ASSUMPTIONS.followUpsPerQuotation + opps * DEFAULT_ASSUMPTIONS.followUpsPerOpportunity;
  return [
    { metric: "Won deals", required: won, basis: b(rates.averageDealValueAed.basis), formula: `target ÷ avg deal value (AED ${Math.round(rates.averageDealValueAed.value).toLocaleString()})` },
    { metric: "Quotations sent", required: quotes, basis: b(rates.averageDealValueAed.basis, rates.quotationWinRate.basis), formula: `won ÷ quotation win rate (${(rates.quotationWinRate.value * 100).toFixed(0)}%)` },
    { metric: "RFQs received", required: rfqsNeeded, basis: b(rates.averageDealValueAed.basis, rates.quotationWinRate.basis, rates.rfqToQuotationRate.basis), formula: `quotations ÷ RFQ→quotation rate (${(rates.rfqToQuotationRate.value * 100).toFixed(0)}%)` },
    { metric: "Qualified opportunities", required: opps, basis: b(rates.averageDealValueAed.basis, rates.quotationWinRate.basis, rates.rfqToQuotationRate.basis, rates.opportunityToRfqRate.basis), formula: `RFQs ÷ opportunity→RFQ rate (${(rates.opportunityToRfqRate.value * 100).toFixed(0)}%)` },
    { metric: "Follow-ups", required: follow, basis: "assumption", formula: `${DEFAULT_ASSUMPTIONS.followUpsPerQuotation}/quotation + ${DEFAULT_ASSUMPTIONS.followUpsPerOpportunity}/opportunity` },
  ];
}

export async function currentRevenueTarget(db: DB, period: string) {
  const [t] = await db
    .select()
    .from(businessTargets)
    .where(and(eq(businessTargets.period, period), eq(businessTargets.metric, "closed_revenue_aed")));
  return t ? { value: n(t.value), isAssumption: t.isAssumption } : null;
}

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export const startOfMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const startOfDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const startOfWeek = (d = new Date()) => {
  const s = startOfDay(d);
  const wd = (s.getUTCDay() + 6) % 7; // Monday = 0
  s.setUTCDate(s.getUTCDate() - wd);
  return s;
};

/** Individual Sales Executive dashboard. All figures are actual DB counts. */
export async function salesExecDashboard(db: DB, employeeId: string) {
  const now = new Date();
  const weekStart = startOfWeek(now);
  const in7 = new Date(now.getTime() + 7 * 86400_000);
  const opps = await db.select().from(opportunities).where(eq(opportunities.ownerEmployeeId, employeeId));
  const ids = opps.map((o) => o.id);
  const [accounts] = await db
    .select({ c: sql<number>`count(*)::int`, week: sql<number>`count(*) filter (where ${accountOwners.assignedAt} >= ${weekStart})::int` })
    .from(accountOwners)
    .where(eq(accountOwners.ownerEmployeeId, employeeId));
  const [fu] = await db
    .select({
      due: sql<number>`count(*) filter (where ${followUps.dueAt} >= ${now} and ${followUps.dueAt} < ${in7})::int`,
      overdue: sql<number>`count(*) filter (where ${followUps.dueAt} < ${now})::int`,
    })
    .from(followUps)
    .where(and(eq(followUps.ownerEmployeeId, employeeId), eq(followUps.status, "pending")));
  let contacted = 0;
  let responses = 0;
  let rfqCount = 0;
  let quotationCount = 0;
  let avgResponseHours: number | null = null;
  if (ids.length) {
    const [ix] = await db
      .select({
        contacted: sql<number>`count(distinct ${interactions.opportunityId}) filter (where ${interactions.direction} = 'outbound' and ${interactions.status} = 'sent')::int`,
        responses: sql<number>`count(*) filter (where ${interactions.direction} = 'inbound')::int`,
      })
      .from(interactions)
      .where(inArray(interactions.opportunityId, ids));
    contacted = n(ix?.contacted);
    responses = n(ix?.responses);
    const [r] = await db.select({ c: sql<number>`count(*)::int` }).from(rfqs).where(inArray(rfqs.opportunityId, ids));
    rfqCount = n(r?.c);
    const [q] = await db
      .select({ c: sql<number>`count(distinct ${stageTransitions.opportunityId})::int` })
      .from(stageTransitions)
      .where(and(inArray(stageTransitions.opportunityId, ids), eq(stageTransitions.toStage, "quotation_sent")));
    quotationCount = n(q?.c);
    // Speed-to-contact: assignment → first sent outbound message, in hours.
    const [rt] = await db.execute(sql`
      select avg(extract(epoch from (first_sent - o.created_at)) / 3600) as h from (
        select i.opportunity_id, min(i.occurred_at) as first_sent from interactions i
        where i.direction = 'outbound' and i.status = 'sent' and i.opportunity_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
        group by i.opportunity_id
      ) s join opportunities o on o.id = s.opportunity_id
    `).then((res) => (res as unknown as { rows: { h: string | null }[] }).rows);
    avgResponseHours = rt?.h != null ? Number(rt.h) : null;
  }
  const active = opps.filter((o) => !TERMINAL_STAGES.includes(o.stage as never));
  const won = opps.filter((o) => o.stage === "won");
  const lost = opps.filter((o) => o.stage === "lost");
  const stale = new Date(now.getTime() - 14 * 86400_000);
  const attention = active.filter((o) => !o.nextAction || !o.nextActionDue || o.nextActionDue < now || o.lastActivityAt < stale);
  return {
    assignedAccounts: n(accounts?.c),
    newAccountsThisWeek: n(accounts?.week),
    activeOpportunities: active.length,
    qualifiedLeads: opps.length,
    customersContacted: contacted,
    responsesReceived: responses,
    rfqsReceived: rfqCount,
    quotationsSubmitted: quotationCount,
    followUpsDue7d: n(fu?.due),
    overdueFollowUps: n(fu?.overdue),
    activeNegotiations: active.filter((o) => o.stage === "negotiation" || o.stage === "verbal_approval").length,
    wonDeals: won.length,
    wonValueAed: won.reduce((s, o) => s + n(o.actualValueAed), 0),
    lostDeals: lost.length,
    pipelineValueAed: active.reduce((s, o) => s + n(o.expectedValueAed), 0),
    pipelineWithoutValue: active.filter((o) => o.expectedValueAed == null).length,
    conversionRate: won.length + lost.length > 0 ? won.length / (won.length + lost.length) : null,
    avgResponseHours,
    dealsRequiringAttention: attention.map((o) => ({
      id: o.id,
      title: o.title,
      stage: o.stage,
      reason: !o.nextAction || !o.nextActionDue ? "No next action" : o.nextActionDue < now ? "Next action overdue" : "No activity for 14+ days",
    })),
  };
}

export async function operationalCounts(db: DB) {
  const [t] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${tasks.status} = 'queued')::int`,
      running: sql<number>`count(*) filter (where ${tasks.status} = 'running')::int`,
      blocked: sql<number>`count(*) filter (where ${tasks.status} = 'blocked')::int`,
      failed: sql<number>`count(*) filter (where ${tasks.status} = 'failed')::int`,
      waiting: sql<number>`count(*) filter (where ${tasks.status} = 'waiting_approval')::int`,
    })
    .from(tasks);
  const [a] = await db.select({ c: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, "pending"));
  const [u] = await db
    .select({ cost: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)`, calls: sql<number>`count(*)::int` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, startOfMonth()));
  return {
    tasksQueued: n(t?.queued),
    tasksRunning: n(t?.running),
    tasksBlocked: n(t?.blocked),
    tasksFailed: n(t?.failed),
    tasksWaitingApproval: n(t?.waiting),
    pendingApprovals: n(a?.c),
    aiCostUsdThisMonth: n(u?.cost),
    aiCallsThisMonth: n(u?.calls),
  };
}
