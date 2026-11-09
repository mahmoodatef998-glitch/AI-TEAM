import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { aiEmployees, tasks } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { cancelTaskAction, launchTaskAction, requeueTaskAction, runQueueAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { A, Card, Empty, fmtDateTime, humanize, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { operationalCounts } from "@/lib/domain/kpi";

const FILTERS = ["active", "blocked", "waiting_approval", "failed", "completed", "all"] as const;

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const { status = "active" } = await searchParams;
  const db = getDb();
  const ops = await operationalCounts(db);
  const where =
    status === "all" ? undefined : status === "active" ? undefined : eq(tasks.status, status as never);
  let rows = await db
    .select({ t: tasks, name: aiEmployees.name, empId: aiEmployees.id })
    .from(tasks)
    .innerJoin(aiEmployees, eq(aiEmployees.id, tasks.assigneeEmployeeId))
    .where(where)
    .orderBy(desc(tasks.updatedAt))
    .limit(200);
  if (status === "active") rows = rows.filter((r) => ["queued", "running"].includes(r.t.status));
  const canWrite = user.role !== "viewer";
  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        subtitle={`${ops.tasksQueued} queued · ${ops.tasksRunning} running · ${ops.tasksWaitingApproval} waiting approval · ${ops.tasksBlocked} blocked · ${ops.tasksFailed} failed`}
        actions={(user.role === "admin" || user.role === "sales_manager") && <form action={runQueueAction}><button className="btn-secondary">Run queue now</button></form>}
      />
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => <Link key={f} href={`/tasks?status=${f}`} className={`rounded-full border px-2.5 py-0.5 text-xs ${status === f ? "border-accent bg-accent/10 text-accent" : "border-border text-muted"}`}>{humanize(f)}</Link>)}
      </div>
      <Card>
        {rows.length === 0 ? <Empty title="No tasks in this view" /> : (
          <Table head={["Task", "Employee", "Status", "Attempts", "Updated", ""]}>
            {rows.map(({ t, name, empId }) => (
              <tr key={t.id}>
                <Td>
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-muted">{t.type}{t.relatedType && t.relatedId && <> · <A href={`/${t.relatedType === "opportunity" ? "opportunities" : "leads"}/${t.relatedId}`}>{t.relatedType}</A></>}</div>
                  {t.blockedReason && <div className="text-xs text-warn">{t.blockedReason}</div>}
                  {t.error && <div className="text-xs text-danger">{t.error}</div>}
                  {t.output && typeof (t.output as { summary?: string }).summary === "string" && <div className="text-xs text-muted">{(t.output as { summary: string }).summary}</div>}
                </Td>
                <Td><A href={`/employees/${empId}`}>{name}</A></Td>
                <Td><StatusBadge s={t.status} />{t.status === "running" && <div className="text-xs text-muted">{t.progress}%</div>}</Td>
                <Td className="tabular-nums text-xs">{t.attempts}/{t.maxAttempts}</Td>
                <Td className="text-xs text-muted">{fmtDateTime(t.updatedAt)}</Td>
                <Td>
                  {canWrite && ["blocked", "failed"].includes(t.status) && <form action={requeueTaskAction.bind(null, t.id)} className="inline"><button className="btn-secondary">Retry</button></form>}
                  {canWrite && ["queued", "blocked", "failed"].includes(t.status) && <form action={cancelTaskAction.bind(null, t.id)} className="ml-1 inline"><button className="btn-secondary">Cancel</button></form>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {canWrite && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Lead discovery run (Lead Generation Specialist)">
            <ActionForm action={launchTaskAction}>
              <input type="hidden" name="type" value="lead.discover" />
              <Field label="Target segment"><input name="segment" placeholder="e.g. contractors building warehouses in Dubai South" className="field" /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Country"><input name="country" defaultValue="UAE" className="field" /></Field>
                <Field label="Max candidates"><input name="maxCandidates" type="number" min="1" max="10" defaultValue="5" className="field" /></Field>
              </div>
              <p className="text-xs text-muted">Uses Claude with server-side web search. Evidence URLs not actually returned by the search are discarded.</p>
              <Submit>Start discovery</Submit>
            </ActionForm>
          </Card>
          <Card title="Assign other work">
            <div className="space-y-4">
              {[
                ["lead.assign", "Sales Director: assign all qualified leads"],
                ["pipeline.review", "Sales Director: pipeline & follow-up review"],
                ["briefing.daily", "CGO: executive briefing"],
                ["kpi.plan", "CGO: refresh KPI plan"],
                ["report.daily_performance", "Business Analyst: performance report"],
              ].map(([type, label]) => (
                <ActionForm key={type} action={launchTaskAction} className="flex items-center justify-between gap-2">
                  <input type="hidden" name="type" value={type} />
                  <span className="text-sm">{label}</span>
                  <Submit variant="secondary">Assign</Submit>
                </ActionForm>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
