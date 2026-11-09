import { asc, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiEmployees, departments, tasks } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { A, Avatar, Badge, Card, humanize, PageHeader, StatusBadge } from "@/components/ui";

export default async function EmployeesPage() {
  await requireUser();
  const db = getDb();
  const depts = await db.select().from(departments).orderBy(asc(departments.createdAt));
  const emps = await db
    .select({
      e: aiEmployees,
      open: sql<number>`(select count(*)::int from ${tasks} where ${tasks.assigneeEmployeeId} = ${aiEmployees.id} and ${tasks.status} in ('queued','running'))`,
      blocked: sql<number>`(select count(*)::int from ${tasks} where ${tasks.assigneeEmployeeId} = ${aiEmployees.id} and ${tasks.status} = 'blocked')`,
      done: sql<number>`(select count(*)::int from ${tasks} where ${tasks.assigneeEmployeeId} = ${aiEmployees.id} and ${tasks.status} = 'completed')`,
    })
    .from(aiEmployees)
    .orderBy(asc(aiEmployees.code));
  const byId = new Map(emps.map((x) => [x.e.id, x.e]));
  return (
    <div className="space-y-6">
      <PageHeader title="AI employees" subtitle={`${emps.length} AI employees across ${depts.length} departments. Each has a defined role, permitted skills, memory and an audit trail.`} />
      {depts.map((d) => (
        <Card key={d.id} title={d.name} actions={<span className="text-xs text-muted">KPIs: {d.kpis.map(humanize).join(", ")}</span>}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {emps.filter((x) => x.e.departmentId === d.id).map(({ e, open, blocked, done }) => (
              <div key={e.id} className="flex gap-3 rounded-md border border-border p-3">
                <Avatar name={e.name} color={e.avatarColor} size={36} />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5"><A href={`/employees/${e.id}`}>{e.name}</A><span className="text-xs text-muted">{e.code}</span><StatusBadge s={e.status} /></div>
                  <div className="text-xs text-muted">{e.title}{e.managerId && byId.get(e.managerId) ? ` · reports to ${byId.get(e.managerId)!.name}` : ""}</div>
                  {e.statusDetail && <div className="mt-1 truncate text-xs">{e.statusDetail}</div>}
                  <div className="mt-1.5 flex flex-wrap gap-1"><Badge>{open} active</Badge><Badge tone="green">{done} done</Badge>{blocked > 0 && <Badge tone="amber">{blocked} blocked</Badge>}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
