import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiEmployees, companies, leads, opportunities, reports } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { setTargetAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { Badge, Card, Empty, fmtAed, fmtDateTime, humanize, PageHeader, Stat, Table, Td } from "@/components/ui";
import { buildKpiPlan, conversionRates, currentRevenueTarget, funnelMetrics, monthKey, operationalCounts, pipelineSnapshot, startOfMonth } from "@/lib/domain/kpi";
import { STAGES, stageLabel } from "@/lib/domain/pipeline";
import { INDUSTRIES } from "@/lib/domain/taxonomy";

export default async function ExecutiveDashboard() {
  const user = await requireUser();
  const db = getDb();
  const period = monthKey();
  const [mtd, allTime, pipe, ops, target, rates] = await Promise.all([
    funnelMetrics(db, startOfMonth(), new Date()),
    funnelMetrics(db, new Date(0), new Date()),
    pipelineSnapshot(db),
    operationalCounts(db),
    currentRevenueTarget(db, period),
    conversionRates(db),
  ]);
  const plan = target ? buildKpiPlan(target.value, rates) : null;
  const byIndustry = await db
    .select({
      industry: companies.industry,
      opps: sql<number>`count(${opportunities.id})::int`,
      won: sql<number>`count(*) filter (where ${opportunities.stage} = 'won')::int`,
      wonValue: sql<string>`coalesce(sum(${opportunities.actualValueAed}) filter (where ${opportunities.stage} = 'won'), 0)`,
    })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .groupBy(companies.industry)
    .orderBy(desc(sql`count(${opportunities.id})`));
  const byMarket = await db
    .select({ country: companies.country, leads: sql<number>`count(${leads.id})::int`, qualified: sql<number>`count(*) filter (where ${leads.score} >= 60)::int` })
    .from(leads)
    .innerJoin(companies, eq(companies.id, leads.companyId))
    .groupBy(companies.country)
    .orderBy(desc(sql`count(${leads.id})`))
    .limit(8);
  const latestBriefing = await db
    .select({ title: reports.title, createdAt: reports.createdAt, data: reports.data, author: aiEmployees.name })
    .from(reports)
    .leftJoin(aiEmployees, eq(aiEmployees.id, reports.authorEmployeeId))
    .where(eq(reports.kind, "daily_briefing"))
    .orderBy(desc(reports.createdAt))
    .limit(1);
  const brief = latestBriefing[0];
  const priorities = (brief?.data as { priorities?: string[] } | undefined)?.priorities ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Executive dashboard"
        subtitle={`Month to date (${period}). All figures are live system counts; revenue counts only won deals with a recorded actual value.`}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Closed revenue (MTD)" value={fmtAed(mtd.wonValueAed)} hint={target ? `${((mtd.wonValueAed / target.value) * 100).toFixed(1)}% of ${fmtAed(target.value)}` : "No target set"} />
        <Stat label="Won deals (MTD)" value={mtd.wonDeals} hint={`${mtd.lostDeals} lost`} />
        <Stat label="Active pipeline" value={pipe.activeCount} hint={pipe.activeValueAed ? fmtAed(pipe.activeValueAed) : "No values entered"} tone={pipe.activeValueEstimatedCount ? "estimate" : undefined} />
        <Stat label="RFQs (MTD)" value={mtd.rfqsReceived} hint={`${mtd.quotationsSent} quotations sent`} />
        <Stat label="Leads (MTD)" value={mtd.leadsCreated} hint={`${mtd.qualifiedLeads} qualified (≥60)`} />
        <Stat label="Pending approvals" value={ops.pendingApprovals} tone={ops.pendingApprovals ? "warn" : undefined} hint={`${ops.tasksBlocked} blocked tasks`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title={`Revenue target & KPI plan — ${period}`} className="xl:col-span-2">
          {plan && target ? (
            <>
              <p className="mb-3 text-sm text-muted">
                Target <strong className="text-text">{fmtAed(target.value)}</strong>. Required activity, reverse-calculated through the funnel:
              </p>
              <Table head={["Metric", "Required", "Month to date", "Basis", "How"]}>
                {plan.map((p) => {
                  const actual = p.metric === "Won deals" ? mtd.wonDeals : p.metric === "Quotations sent" ? mtd.quotationsSent : p.metric === "RFQs received" ? mtd.rfqsReceived : p.metric === "Qualified opportunities" ? mtd.opportunitiesCreated : null;
                  return (
                    <tr key={p.metric}>
                      <Td className="font-medium">{p.metric}</Td>
                      <Td className="tabular-nums">{p.required}</Td>
                      <Td className="tabular-nums">{actual ?? "—"}</Td>
                      <Td><Badge tone={p.basis === "historical" ? "green" : "amber"}>{p.basis}</Badge></Td>
                      <Td className="text-xs text-muted">{p.formula}</Td>
                    </tr>
                  );
                })}
              </Table>
              {plan.some((p) => p.basis !== "historical") && (
                <p className="mt-3 text-xs text-warn">
                  Amber rows use initial planning assumptions because there is not yet enough closed-deal history. They switch to historical rates automatically as deals close.
                </p>
              )}
            </>
          ) : (
            <Empty title="No revenue target set for this month">
              The CGO will not invent a target. {user.role === "admin" ? "Set one below to generate the KPI plan." : "Ask an administrator to set it."}
            </Empty>
          )}
          {user.role === "admin" && (
            <ActionForm action={setTargetAction} className="mt-4 flex flex-wrap items-end gap-3">
              <Field label="Period (YYYY-MM)"><input name="period" defaultValue={period} className="field w-32" /></Field>
              <Field label="Closed revenue target (AED)"><input name="value" type="number" min="1" step="1000" defaultValue={target?.value ?? ""} className="field w-48" /></Field>
              <Submit>Save target</Submit>
            </ActionForm>
          )}
        </Card>

        <Card title="Today's priorities" actions={brief && <span className="text-xs text-muted">{brief.author} · {fmtDateTime(brief.createdAt)}</span>}>
          {brief ? (
            priorities.length ? (
              <ul className="space-y-2 text-sm">{priorities.map((p, i) => <li key={i} className="flex gap-2"><span className="text-warn">•</span>{p}</li>)}</ul>
            ) : (
              <p className="text-sm text-muted">No blockers in the latest briefing.</p>
            )
          ) : (
            <Empty title="No briefing yet">The CGO issues the briefing at 09:00 (Dubai) on weekdays once the worker or cron is running.</Empty>
          )}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Pipeline by stage">
          {pipe.byStage.length === 0 ? (
            <Empty title="No opportunities yet">Opportunities are created when qualified leads are assigned to a Sales Executive.</Empty>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {STAGES.filter((s) => pipe.byStage.some((b) => b.stage === s.key)).map((s) => {
                const b = pipe.byStage.find((x) => x.stage === s.key)!;
                return (
                  <li key={s.key} className="flex justify-between gap-2">
                    <span>{stageLabel(s.key)}</span>
                    <span className="tabular-nums text-muted">{b.count}{b.valueAed ? ` · ${fmtAed(b.valueAed)}` : ""}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Industries (opportunities)">
          {byIndustry.length === 0 ? <Empty title="No data yet" /> : (
            <ul className="space-y-1.5 text-sm">
              {byIndustry.map((r) => (
                <li key={r.industry ?? "unknown"} className="flex justify-between gap-2">
                  <span>{r.industry ? INDUSTRIES[r.industry]?.label ?? humanize(r.industry) : "Unknown"}</span>
                  <span className="tabular-nums text-muted">{r.opps} opp · {r.won} won{Number(r.wonValue) ? ` · ${fmtAed(r.wonValue)}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Markets (leads)">
          {byMarket.length === 0 ? <Empty title="No data yet" /> : (
            <ul className="space-y-1.5 text-sm">
              {byMarket.map((r) => (
                <li key={r.country ?? "unknown"} className="flex justify-between gap-2">
                  <span>{r.country ?? "Unknown"}</span>
                  <span className="tabular-nums text-muted">{r.leads} leads · {r.qualified} qualified</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="All-time leads" value={allTime.leadsCreated} />
        <Stat label="All-time won value" value={fmtAed(allTime.wonValueAed)} />
        <Stat label="Marketing spend" value="—" hint="Google Ads not connected" />
        <Stat label="AI cost this month" value={`$${ops.aiCostUsdThisMonth.toFixed(2)}`} hint={`${ops.aiCallsThisMonth} model calls`} />
      </div>
    </div>
  );
}
