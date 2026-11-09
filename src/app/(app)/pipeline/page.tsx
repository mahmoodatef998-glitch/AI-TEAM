import { eq } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { aiEmployees, companies, opportunities } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { Empty, fmtAed, fmtDate, PageHeader } from "@/components/ui";
import { STAGES } from "@/lib/domain/pipeline";

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ owner?: string; closed?: string }> }) {
  await requireUser();
  const { owner, closed } = await searchParams;
  const db = getDb();
  const rows = await db
    .select({ o: opportunities, company: companies.name, ownerName: aiEmployees.name, ownerColor: aiEmployees.avatarColor })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(aiEmployees, eq(aiEmployees.id, opportunities.ownerEmployeeId))
    .where(owner ? eq(opportunities.ownerEmployeeId, owner) : undefined);
  const execs = await db.select().from(aiEmployees).where(eq(aiEmployees.isSalesExecutive, true));
  const now = new Date();
  const stages = STAGES.filter((s) => closed === "1" || !["won", "lost", "disqualified"].includes(s.key));
  return (
    <div>
      <PageHeader
        title="Sales pipeline"
        subtitle="18-stage pipeline. Every active opportunity has one owner and a dated next action; every transition is recorded."
      />
      <div className="mb-4 flex flex-wrap gap-1.5 text-xs">
        <Link href="/pipeline" className={`rounded-full border px-2.5 py-0.5 ${!owner ? "border-accent text-accent" : "border-border text-muted"}`}>All owners</Link>
        {execs.map((e) => <Link key={e.id} href={`/pipeline?owner=${e.id}`} className={`rounded-full border px-2.5 py-0.5 ${owner === e.id ? "border-accent text-accent" : "border-border text-muted"}`}>{e.name}</Link>)}
        <Link href={`/pipeline?${owner ? `owner=${owner}&` : ""}closed=${closed === "1" ? "0" : "1"}`} className="rounded-full border border-border px-2.5 py-0.5 text-muted">{closed === "1" ? "Hide closed" : "Show closed"}</Link>
      </div>
      {rows.length === 0 ? (
        <Empty title="No opportunities yet">Opportunities appear here when qualified leads are assigned to a Sales Executive.</Empty>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {stages.map((s) => {
            const items = rows.filter((r) => r.o.stage === s.key);
            return (
              <div key={s.key} className="w-64 shrink-0 rounded-lg border border-border bg-surface-2">
                <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-semibold">
                  <span>{s.label}</span><span className="text-muted">{items.length}</span>
                </div>
                <div className="space-y-2 p-2">
                  {items.map(({ o, company, ownerName, ownerColor }) => {
                    const overdue = o.nextActionDue && o.nextActionDue < now;
                    return (
                      <Link key={o.id} href={`/opportunities/${o.id}`} className="block rounded-md border border-border bg-surface p-2.5 text-xs hover:border-accent">
                        <div className="font-medium text-text">{company}</div>
                        <div className="mt-0.5 text-muted">{o.capacityKva ? `${o.capacityKva} kVA` : "Capacity TBC"}{o.expectedValueAed ? ` · ${fmtAed(o.expectedValueAed)}${o.valueIsEstimate ? " (est.)" : ""}` : ""}</div>
                        <div className="mt-1.5 flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: ownerColor }} />{ownerName}</div>
                        {o.nextAction && <div className={`mt-1.5 ${overdue ? "text-danger" : "text-muted"}`}>{overdue ? "Overdue: " : "Next: "}{o.nextAction} · {fmtDate(o.nextActionDue)}</div>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
