import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { campaigns, leads, reports } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { launchTaskAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { Badge, Card, Empty, fmtAed, fmtDateTime, humanize, PageHeader, Stat, Table, Td } from "@/components/ui";
import { integrationStatuses } from "@/lib/integrations/registry";

export default async function MarketingPage() {
  const user = await requireUser();
  const db = getDb();
  const ints = integrationStatuses();
  const ga4 = ints.find((i) => i.key === "ga4")!;
  const gsc = ints.find((i) => i.key === "gsc")!;
  const ads = ints.find((i) => i.key === "google_ads")!;
  const bySource = await db
    .select({ source: leads.source, total: sql<number>`count(*)::int`, qualified: sql<number>`count(*) filter (where ${leads.score} >= 60)::int` })
    .from(leads)
    .groupBy(leads.source)
    .orderBy(desc(sql`count(*)`));
  const camps = await db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(20);
  const [seo] = await db.select().from(reports).where(eq(reports.kind, "seo_audit")).orderBy(desc(reports.createdAt)).limit(1);
  const seoData = seo?.data as { pagesCrawled: number; issueCounts: Record<string, number>; duplicateTitles: string[]; dataNote?: string } | undefined;
  const canWrite = user.role !== "viewer";
  const notConnected = (n: string) => <span className="text-xs text-muted">{n} not connected</span>;
  return (
    <div className="space-y-6">
      <PageHeader title="Marketing" subtitle="Optimised for qualified RFQs. Analytics figures appear only when the real data source is connected." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Website visitors" value="—" hint={ga4.configured ? "GA4 connected" : notConnected("GA4")} />
        <Stat label="Organic clicks" value="—" hint={gsc.configured ? "Search Console connected" : notConnected("Search Console")} />
        <Stat label="Ad spend (MTD)" value="—" hint={ads.configured ? "Google Ads connected" : notConnected("Google Ads")} />
        <Stat label="Cost per qualified lead" value="—" hint="Requires ad spend data" />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Leads by source (actual)">
          {bySource.length === 0 ? <Empty title="No leads yet" /> : (
            <Table head={["Source", "Leads", "Qualified", "Qualification rate"]}>
              {bySource.map((r) => <tr key={r.source}><Td>{humanize(r.source)}</Td><Td className="tabular-nums">{r.total}</Td><Td className="tabular-nums">{r.qualified}</Td><Td className="tabular-nums">{r.total ? `${Math.round((r.qualified / r.total) * 100)}%` : "—"}</Td></tr>)}
            </Table>
          )}
        </Card>
        <Card title="Latest SEO audit" actions={seo && <span className="text-xs text-muted">{fmtDateTime(seo.createdAt)}</span>}>
          {seoData ? (
            <div className="text-sm">
              <p>{seoData.pagesCrawled} page(s) crawled.</p>
              <ul className="mt-2 space-y-1">{Object.entries(seoData.issueCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="tabular-nums text-muted">{v}</span></li>)}</ul>
              {seoData.duplicateTitles.length > 0 && <p className="mt-2 text-xs text-warn">Duplicate titles: {seoData.duplicateTitles.join("; ")}</p>}
              {seoData.dataNote && <p className="mt-2 text-xs text-muted">{seoData.dataNote}</p>}
            </div>
          ) : <Empty title="No SEO audit yet">Run one below — it crawls 4ugenerators.com and checks titles, meta descriptions, headings, canonicals, alt text and thin content.</Empty>}
        </Card>
      </div>
      <Card title="Campaigns">
        {camps.length === 0 ? <Empty title="No campaigns">The Marketing Director proposes draft campaigns; launching any campaign requires approval.</Empty> : (
          <Table head={["Campaign", "Channel", "Status", "Proposed budget", "Actual spend"]}>
            {camps.map((c) => <tr key={c.id}><Td><div className="font-medium">{c.name}</div><div className="text-xs text-muted">{c.objective}</div></Td><Td>{c.channel}</Td><Td><Badge tone="amber">{c.status}</Badge></Td><Td>{fmtAed(c.proposedBudgetAed)} {c.proposedBudgetAed && <Badge tone="amber">proposal</Badge>}</Td><Td>{fmtAed(c.actualSpendAed)}</Td></tr>)}
          </Table>
        )}
      </Card>
      {canWrite && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Assign marketing work">
            <div className="space-y-4">
              <ActionForm action={launchTaskAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="type" value="seo.audit" />
                <Field label="SEO audit — pages to crawl"><input name="maxPages" type="number" min="1" max="25" defaultValue="15" className="field w-24" /></Field>
                <Submit variant="secondary">Assign to Yusuf (SEO)</Submit>
              </ActionForm>
              <ActionForm action={launchTaskAction} className="flex items-center justify-between gap-2">
                <input type="hidden" name="type" value="marketing.plan" />
                <span className="text-sm">Marketing strategy & draft campaigns</span>
                <Submit variant="secondary">Assign to Layla</Submit>
              </ActionForm>
              <ActionForm action={launchTaskAction} className="flex items-center justify-between gap-2">
                <input type="hidden" name="type" value="ads.review" />
                <span className="text-sm">Google Ads performance review</span>
                <Submit variant="secondary">Assign to Karim</Submit>
              </ActionForm>
            </div>
          </Card>
          <Card title="Content & intelligence">
            <ActionForm action={launchTaskAction}>
              <input type="hidden" name="type" value="content.draft" />
              <Field label="Content brief (Maya)"><textarea name="brief" rows={2} placeholder="e.g. LinkedIn post: prime vs standby ratings for UAE factories" className="field" /></Field>
              <Submit variant="secondary">Draft content (publishing needs approval)</Submit>
            </ActionForm>
            <ActionForm action={launchTaskAction} className="mt-4 space-y-3 border-t border-border pt-4">
              <input type="hidden" name="type" value="competitor.research" />
              <Field label="Competitor research scope (Tariq)"><input name="scope" placeholder="diesel generator suppliers in Sharjah and Dubai" className="field" /></Field>
              <Submit variant="secondary">Research competitors</Submit>
            </ActionForm>
          </Card>
        </div>
      )}
    </div>
  );
}
