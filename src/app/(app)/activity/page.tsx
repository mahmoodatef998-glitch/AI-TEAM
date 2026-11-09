import { desc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { activityLog, aiEmployees, users } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { Badge, Card, Empty, fmtDateTime, PageHeader, Table, Td } from "@/components/ui";

export default async function ActivityPage() {
  await requireUser();
  const db = getDb();
  const rows = await db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(300);
  const ids = [...new Set(rows.map((r) => r.actorId).filter(Boolean) as string[])];
  const [emps, usrs] = ids.length ? await Promise.all([db.select().from(aiEmployees).where(inArray(aiEmployees.id, ids)), db.select().from(users).where(inArray(users.id, ids))]) : [[], []];
  const actor = (t: string, id: string | null) => (t === "agent" ? emps.find((e) => e.id === id)?.name : t === "user" ? usrs.find((u) => u.id === id)?.name : "System") ?? "—";
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Append-only record of every action by humans, AI employees and the system." />
      <Card>
        {rows.length === 0 ? <Empty title="No activity yet" /> : (
          <Table head={["When", "Actor", "Action", "Summary"]}>
            {rows.map((r) => <tr key={r.id}><Td className="whitespace-nowrap text-xs text-muted">{fmtDateTime(r.createdAt)}</Td><Td className="whitespace-nowrap"><Badge tone={r.actorType === "user" ? "purple" : r.actorType === "agent" ? "blue" : "gray"}>{r.actorType}</Badge> {actor(r.actorType, r.actorId)}</Td><Td className="text-xs">{r.action}</Td><Td className="text-xs">{r.summary}</Td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}
