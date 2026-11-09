import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { aiEmployees, companies, leadEvidence, leads } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { A, Badge, Card, Empty, fmtDate, humanize, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { INDUSTRIES } from "@/lib/domain/taxonomy";

const FILTERS = ["all", "new", "qualified", "needs_more_research", "low_priority", "assigned", "duplicate", "rejected"] as const;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireUser();
  const { status = "all" } = await searchParams;
  const db = getDb();
  const rows = await db
    .select({
      id: leads.id, status: leads.status, score: leads.score, priority: leads.priority, signal: leads.signalStrength,
      summary: leads.requirementSummary, source: leads.source, createdAt: leads.createdAt,
      company: companies.name, country: companies.country, industry: companies.industry,
      discoveredBy: aiEmployees.name,
      evidence: sql<number>`(select count(*)::int from ${leadEvidence} where ${leadEvidence.leadId} = ${leads.id})`,
    })
    .from(leads)
    .innerJoin(companies, eq(companies.id, leads.companyId))
    .leftJoin(aiEmployees, eq(aiEmployees.id, leads.discoveredByEmployeeId))
    .where(status !== "all" ? eq(leads.status, status as never) : undefined)
    .orderBy(desc(leads.createdAt))
    .limit(300);
  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Every lead has a traceable source. Scores are evidence-based; high scores require evidence."
        actions={<Link href="/leads/new" className="btn">Add lead</Link>}
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link key={f} href={f === "all" ? "/leads" : `/leads?status=${f}`} className={`rounded-full border px-2.5 py-0.5 text-xs ${status === f ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:text-text"}`}>
            {humanize(f)}
          </Link>
        ))}
      </div>
      <Card>
        {rows.length === 0 ? (
          <Empty title="No leads yet">
            Add a lead manually with its source, or launch a discovery run from the Tasks page (requires the Anthropic API key for web research). No sample or fabricated leads are loaded.
          </Empty>
        ) : (
          <Table head={["Company", "Score", "Signal", "Requirement", "Evidence", "Source", "Status", "Added"]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <A href={`/leads/${r.id}`}>{r.company}</A>
                  <div className="text-xs text-muted">{[r.industry ? INDUSTRIES[r.industry]?.label : null, r.country].filter(Boolean).join(" · ")}</div>
                </Td>
                <Td className="tabular-nums">{r.score ?? "—"}{r.priority && <div><Badge tone={r.priority === "high_priority" ? "green" : r.priority === "qualified" ? "teal" : r.priority === "needs_more_research" ? "amber" : "red"}>{humanize(r.priority)}</Badge></div>}</Td>
                <Td className="text-xs">{humanize(r.signal)}</Td>
                <Td className="max-w-xs text-xs text-muted">{r.summary ?? "—"}</Td>
                <Td className="tabular-nums">{r.evidence}</Td>
                <Td className="text-xs">{humanize(r.source)}{r.discoveredBy && <div className="text-muted">by {r.discoveredBy}</div>}</Td>
                <Td><StatusBadge s={r.status} /></Td>
                <Td className="text-xs text-muted">{fmtDate(r.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
