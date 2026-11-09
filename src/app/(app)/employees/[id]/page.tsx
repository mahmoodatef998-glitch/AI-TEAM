import { and, desc, eq, notInArray, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { accountOwners, activityLog, agentMemories, aiEmployees, aiUsage, companies, departments, messages, opportunities, tasks } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { A, Avatar, Badge, Card, Empty, fmtAed, fmtDateTime, humanize, PageHeader, Stat, StatusBadge, Table, Td } from "@/components/ui";
import { salesExecDashboard } from "@/lib/domain/kpi";
import { stageLabel, TERMINAL_STAGES } from "@/lib/domain/pipeline";
import { getSkill } from "@/lib/agents/registry";

export default async function EmployeeProfile({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const db = getDb();
  const [e] = await db.select().from(aiEmployees).where(eq(aiEmployees.id, id));
  if (!e) notFound();
  const [[dept], [manager], current, history, blockers, mems, msgs, log, accounts, usage] = await Promise.all([
    db.select().from(departments).where(eq(departments.id, e.departmentId)),
    e.managerId ? db.select().from(aiEmployees).where(eq(aiEmployees.id, e.managerId)) : Promise.resolve([]),
    e.currentTaskId ? db.select().from(tasks).where(eq(tasks.id, e.currentTaskId)) : Promise.resolve([]),
    db.select().from(tasks).where(eq(tasks.assigneeEmployeeId, id)).orderBy(desc(tasks.updatedAt)).limit(40),
    db.select().from(tasks).where(and(eq(tasks.assigneeEmployeeId, id), eq(tasks.status, "blocked"))),
    db.select().from(agentMemories).where(eq(agentMemories.employeeId, id)).orderBy(desc(agentMemories.createdAt)).limit(40),
    db.select({ m: messages, fromName: aiEmployees.name }).from(messages).leftJoin(aiEmployees, eq(aiEmployees.id, messages.fromEmployeeId)).where(or(eq(messages.toEmployeeId, id), eq(messages.fromEmployeeId, id))).orderBy(desc(messages.createdAt)).limit(30),
    db.select().from(activityLog).where(and(eq(activityLog.actorType, "agent"), eq(activityLog.actorId, id))).orderBy(desc(activityLog.createdAt)).limit(40),
    e.isSalesExecutive
      ? db.select({ o: opportunities, company: companies.name }).from(opportunities).innerJoin(companies, eq(companies.id, opportunities.companyId)).where(and(eq(opportunities.ownerEmployeeId, id), notInArray(opportunities.stage, TERMINAL_STAGES))).orderBy(desc(opportunities.updatedAt))
      : Promise.resolve([]),
    db.select().from(aiUsage).where(eq(aiUsage.employeeId, id)),
  ]);
  const owned = e.isSalesExecutive ? await db.select({ c: accountOwners.companyId }).from(accountOwners).where(eq(accountOwners.ownerEmployeeId, id)) : [];
  const dash = e.isSalesExecutive ? await salesExecDashboard(db, id) : null;
  const completed = history.filter((t) => t.status === "completed").length;
  const cost = usage.reduce((s, u) => s + Number(u.costUsd), 0);
  return (
    <div className="space-y-6">
      <PageHeader
        title={`${e.name} — ${e.title}`}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Avatar name={e.name} color={e.avatarColor} size={22} />{dept.name} · {e.code}{manager && <> · reports to <A href={`/employees/${manager.id}`}>{manager.name}</A></>} · <StatusBadge s={e.status} /> · in {humanize(e.location)}</span>}
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Job description" className="xl:col-span-2">
          <p className="text-sm">{e.jobDescription}</p>
          <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-muted">{e.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
          <div className="mt-3 flex flex-wrap gap-1.5">{e.skills.map((s) => <Badge key={s} tone="teal">{getSkill(s)?.label ?? s}</Badge>)}</div>
          <p className="mt-3 text-xs text-muted"><strong>Persona:</strong> {e.persona}</p>
          {e.specialization?.notes && <p className="mt-1 text-xs text-muted"><strong>Specialization:</strong> {e.specialization.notes}</p>}
        </Card>
        <Card title="Right now">
          {current[0] ? (
            <div className="text-sm"><div className="font-medium">{current[0].title}</div><div className="mt-1 h-1.5 rounded bg-surface-2"><div className="h-1.5 rounded bg-accent" style={{ width: `${current[0].progress}%` }} /></div><div className="mt-1 text-xs text-muted">{current[0].progress}% · {e.statusDetail}</div></div>
          ) : e.status === "waiting_approval" ? (
            <p className="text-sm">Waiting for human approval: {e.statusDetail}</p>
          ) : e.status === "error" ? (
            <p className="text-sm text-danger">{e.statusDetail}</p>
          ) : (
            <p className="text-sm text-muted">Idle at desk. Last active {fmtDateTime(e.lastActiveAt)}.</p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Stat label="Completed tasks" value={completed} />
            <Stat label="AI cost" value={`$${cost.toFixed(2)}`} hint={`${usage.length} calls`} />
          </div>
        </Card>
      </div>
      {blockers.length > 0 && (
        <Card title={`Current blockers (${blockers.length})`}>
          <ul className="space-y-1.5 text-sm">{blockers.map((b) => <li key={b.id}><strong>{b.title}:</strong> <span className="text-warn">{b.blockedReason}</span></li>)}</ul>
        </Card>
      )}
      {dash && (
        <Card title="Performance">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
            <Stat label="Accounts" value={owned.length} />
            <Stat label="Active opps" value={dash.activeOpportunities} />
            <Stat label="Contacted" value={dash.customersContacted} />
            <Stat label="RFQs" value={dash.rfqsReceived} />
            <Stat label="Quotations" value={dash.quotationsSubmitted} />
            <Stat label="Won" value={dash.wonDeals} hint={fmtAed(dash.wonValueAed)} />
            <Stat label="Lost" value={dash.lostDeals} />
            <Stat label="Overdue" value={dash.overdueFollowUps} tone={dash.overdueFollowUps ? "warn" : undefined} />
          </div>
        </Card>
      )}
      {e.isSalesExecutive && (
        <Card title={`Assigned accounts (${accounts.length} active)`}>
          {accounts.length === 0 ? <Empty title="No active accounts" /> : (
            <Table head={["Account", "Stage", "Next action", "Due"]}>
              {accounts.map(({ o, company }) => <tr key={o.id}><Td><A href={`/opportunities/${o.id}`}>{company}</A></Td><Td>{stageLabel(o.stage)}</Td><Td className="text-xs">{o.nextAction}</Td><Td className="text-xs">{fmtDateTime(o.nextActionDue)}</Td></tr>)}
            </Table>
          )}
        </Card>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Task history">
          {history.length === 0 ? <Empty title="No tasks yet" /> : (
            <ul className="space-y-2 text-sm">{history.map((t) => <li key={t.id} className="flex flex-wrap items-center gap-2"><StatusBadge s={t.status} /><span>{t.title}</span><span className="text-xs text-muted">{fmtDateTime(t.updatedAt)}</span>{t.output && typeof (t.output as { summary?: string }).summary === "string" && <div className="w-full text-xs text-muted">{(t.output as { summary: string }).summary}</div>}{t.error && <div className="w-full text-xs text-danger">{t.error}</div>}</li>)}</ul>
          )}
        </Card>
        <Card title="Messages">
          {msgs.length === 0 ? <Empty title="No messages yet" /> : (
            <ul className="space-y-2 text-sm">{msgs.map(({ m, fromName }) => <li key={m.id}><div className="text-xs text-muted">{fmtDateTime(m.createdAt)} · {m.fromEmployeeId === id ? "sent" : `from ${fromName ?? "user"}`} · {humanize(m.kind)}</div><div className="font-medium">{m.subject}</div><p className="whitespace-pre-wrap text-xs text-muted">{m.body}</p></li>)}</ul>
          )}
        </Card>
        <Card title="Memory">
          {mems.length === 0 ? <Empty title="No memories yet" /> : (
            <ul className="space-y-2 text-sm">{mems.map((m) => <li key={m.id}><Badge>{humanize(m.kind)}</Badge> <span className="text-xs text-muted">importance {m.importance} · {fmtDateTime(m.createdAt)}</span><p className="mt-0.5">{m.content}</p></li>)}</ul>
          )}
        </Card>
        <Card title="Activity log">
          {log.length === 0 ? <Empty title="No activity yet" /> : (
            <ul className="space-y-1.5 text-xs">{log.map((l) => <li key={l.id}><span className="text-muted">{fmtDateTime(l.createdAt)}</span> · {l.summary}</li>)}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}
