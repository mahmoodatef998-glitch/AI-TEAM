import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { A, Avatar, Badge, Card, fmtAed, PageHeader, Stat } from "@/components/ui";
import { listSalesExecutives } from "@/lib/domain/employees";
import { salesExecDashboard } from "@/lib/domain/kpi";
import { stageLabel } from "@/lib/domain/pipeline";

export default async function SalesTeamPage() {
  await requireUser();
  const db = getDb();
  const execs = await listSalesExecutives(db);
  const dashboards = await Promise.all(execs.map(async (e) => ({ e, d: await salesExecDashboard(db, e.id) })));
  return (
    <div className="space-y-6">
      <PageHeader title="Sales team" subtitle="Four independent AI Sales Executives. Each owns their accounts end-to-end; figures are actual counts." />
      <div className="grid gap-6 2xl:grid-cols-2">
        {dashboards.map(({ e, d }) => {
          const t = e.targets;
          return (
            <Card
              key={e.id}
              title={<span className="flex items-center gap-2"><Avatar name={e.name} color={e.avatarColor} /> <A href={`/employees/${e.id}`}>{e.name}</A> <span className="font-normal text-muted">· {e.title}</span></span>}
              actions={<Badge tone={e.status === "idle" ? "gray" : "blue"}>{e.status.replace(/_/g, " ")}</Badge>}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Accounts" value={d.assignedAccounts} hint={`${d.newAccountsThisWeek} new this week`} />
                <Stat label="Active opps" value={d.activeOpportunities} />
                <Stat label="Contacted" value={d.customersContacted} hint={`${d.responsesReceived} responses`} />
                <Stat label="RFQs / quotes" value={`${d.rfqsReceived} / ${d.quotationsSubmitted}`} />
                <Stat label="Follow-ups due (7d)" value={d.followUpsDue7d} />
                <Stat label="Overdue" value={d.overdueFollowUps} tone={d.overdueFollowUps ? "warn" : undefined} />
                <Stat label="Won / lost" value={`${d.wonDeals} / ${d.lostDeals}`} hint={d.conversionRate != null ? `${Math.round(d.conversionRate * 100)}% win rate` : "No closed deals"} />
                <Stat label="Pipeline" value={d.pipelineValueAed ? fmtAed(d.pipelineValueAed) : "—"} hint={d.pipelineWithoutValue ? `${d.pipelineWithoutValue} without value` : undefined} />
              </div>
              <div className="mt-3 text-xs text-muted">
                Avg. time to first contact: {d.avgResponseHours != null ? `${d.avgResponseHours.toFixed(1)} h` : "—"} · Negotiations: {d.activeNegotiations}
                {t?.monthly && <> · Monthly targets{t.isAssumption ? " (initial assumption)" : ""}: {Object.entries(t.monthly).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}</>}
              </div>
              {d.dealsRequiringAttention.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs font-semibold text-warn">Deals requiring attention</div>
                  <ul className="mt-1 space-y-1 text-sm">
                    {d.dealsRequiringAttention.slice(0, 5).map((x) => <li key={x.id}><A href={`/opportunities/${x.id}`}>{x.title}</A> <span className="text-xs text-muted">· {stageLabel(x.stage)} · {x.reason}</span></li>)}
                  </ul>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
