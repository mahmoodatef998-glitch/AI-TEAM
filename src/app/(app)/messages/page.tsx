import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiEmployees } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { Badge, Card, Empty, fmtDateTime, humanize, PageHeader } from "@/components/ui";
import { searchMessages } from "@/lib/domain/messaging";

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ q?: string; employee?: string }> }) {
  await requireUser();
  const { q = "", employee } = await searchParams;
  const db = getDb();
  const rows = await searchMessages(db, q, { employeeId: employee || undefined, limit: 150 });
  const empIds = [...new Set(rows.flatMap((r) => [r.fromEmployeeId, r.toEmployeeId]).filter(Boolean) as string[])];
  const emps = empIds.length ? await db.select().from(aiEmployees).where(inArray(aiEmployees.id, empIds)) : [];
  const all = await db.select({ id: aiEmployees.id, name: aiEmployees.name }).from(aiEmployees).orderBy(aiEmployees.code);
  const name = (id: string | null) => (id ? emps.find((e) => e.id === id)?.name ?? "?" : null);
  return (
    <div className="space-y-6">
      <PageHeader title="Internal messages" subtitle="All communication between AI employees is stored and full-text searchable." />
      <form className="flex flex-wrap gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Search messages (e.g. RFQ, Cummins, overdue)" className="field max-w-md" aria-label="Search messages" />
        <select name="employee" defaultValue={employee ?? ""} className="field w-48" aria-label="Filter by employee">
          <option value="">All employees</option>
          {all.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button className="btn-secondary">Search</button>
      </form>
      <Card>
        {rows.length === 0 ? <Empty title={q ? "No messages match" : "No messages yet"}>Messages appear as AI employees assign work, share research, report and escalate.</Empty> : (
          <ul className="divide-y divide-border">
            {rows.map((m) => (
              <li key={m.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge tone={m.kind === "escalation" ? "red" : m.kind === "task_assignment" ? "blue" : "gray"}>{humanize(m.kind)}</Badge>
                  <span><strong className="text-text">{name(m.fromEmployeeId) ?? "Human user"}</strong> → <strong className="text-text">{name(m.toEmployeeId) ?? "Human team"}</strong></span>
                  <span>{fmtDateTime(m.createdAt)}</span>
                </div>
                {m.subject && <div className="mt-1 font-medium">{m.subject}</div>}
                <p className="mt-0.5 whitespace-pre-wrap text-muted">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
