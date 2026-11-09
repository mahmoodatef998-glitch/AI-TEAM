import { z } from "zod";
import { campaigns, reports } from "@/lib/db/schema";
import { generateStructured, researchWeb } from "@/lib/ai/router";
import { requestApproval } from "@/lib/domain/approvals";
import { getKnowledge, knowledgeAsPrompt } from "@/lib/domain/knowledge";
import { funnelMetrics, pipelineSnapshot } from "@/lib/domain/kpi";
import { integrationStatuses } from "@/lib/integrations/registry";
import type { Skill } from "../types";

const SITE = process.env.COMPANY_WEBSITE ?? "https://www.4ugenerators.com/";

interface PageAudit {
  url: string;
  status: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  canonical: string | null;
  imagesWithoutAlt: number;
  wordCount: number;
  issues: string[];
}

function auditHtml(url: string, status: number, html: string): PageAudit {
  const pick = (re: RegExp) => html.match(re)?.[1]?.trim() ?? null;
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ?? pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imagesWithoutAlt = imgs.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length;
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const issues: string[] = [];
  if (status >= 400) issues.push(`HTTP ${status}`);
  if (!title) issues.push("Missing <title>");
  else if (title.length > 65) issues.push(`Title too long (${title.length} chars)`);
  else if (title.length < 20) issues.push(`Title too short (${title.length} chars)`);
  if (!metaDescription) issues.push("Missing meta description");
  else if (metaDescription.length > 165) issues.push(`Meta description too long (${metaDescription.length})`);
  if (h1.length === 0) issues.push("No H1");
  if (h1.length > 1) issues.push(`${h1.length} H1 headings`);
  if (!canonical) issues.push("No canonical tag");
  if (imagesWithoutAlt) issues.push(`${imagesWithoutAlt} image(s) without alt text`);
  if (wordCount < 250) issues.push(`Thin content (~${wordCount} words)`);
  if (!/generator/i.test(`${title} ${h1.join(" ")}`)) issues.push("Primary keyword 'generator' absent from title/H1");
  return { url, status, title, metaDescription, h1, canonical, imagesWithoutAlt, wordCount, issues };
}

/** Real technical SEO crawl of the company website (homepage + internal links, capped). */
export const seoAudit: Skill = {
  type: "seo.audit",
  label: "Technical SEO audit of 4ugenerators.com",
  office: { status: "analyzing", location: "marketing_department" },
  async run({ db, task, employee, progress }) {
    const maxPages = Math.min(25, Number(task.input.maxPages ?? 15));
    const origin = new URL(SITE).origin;
    const queue = [SITE];
    const seen = new Set<string>();
    const pages: PageAudit[] = [];
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "4U-AI-Workforce-SEO-Audit/1.0" }, signal: AbortSignal.timeout(15000) });
        const html = res.headers.get("content-type")?.includes("html") ? await res.text() : "";
        pages.push(auditHtml(url, res.status, html));
        for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
          try {
            const u = new URL(m[1], url);
            if (u.origin === origin && !/\.(jpg|jpeg|png|gif|pdf|zip|webp|svg|css|js)$/i.test(u.pathname)) {
              const clean = `${u.origin}${u.pathname}`;
              if (!seen.has(clean)) queue.push(clean);
            }
          } catch {
            /* ignore malformed links */
          }
        }
      } catch (e) {
        pages.push({ url, status: null, title: null, metaDescription: null, h1: [], canonical: null, imagesWithoutAlt: 0, wordCount: 0, issues: [`Fetch failed: ${(e as Error).message}`] });
      }
      await progress((pages.length / maxPages) * 90);
    }
    if (pages.length === 1 && pages[0].status === null) {
      return { status: "blocked", reason: `Could not reach ${SITE} from the server (${pages[0].issues[0]}). Check outbound network access.` };
    }
    const titles = new Map<string, number>();
    for (const p of pages) if (p.title) titles.set(p.title, (titles.get(p.title) ?? 0) + 1);
    const duplicateTitles = [...titles].filter(([, c]) => c > 1).map(([t, c]) => `${t} (${c} pages)`);
    const issueCounts: Record<string, number> = {};
    for (const p of pages) for (const i of p.issues) {
      const k = i.replace(/\(.*?\)|\d+/g, "").trim();
      issueCounts[k] = (issueCounts[k] ?? 0) + 1;
    }
    const gsc = integrationStatuses().find((i) => i.key === "gsc")!;
    const data = {
      site: SITE,
      pagesCrawled: pages.length,
      issueCounts,
      duplicateTitles,
      pages,
      dataNote: gsc.configured ? "" : "Rankings, impressions and CTR require Google Search Console access (not configured). This audit covers on-page technical checks only.",
    };
    await db.insert(reports).values({ kind: "seo_audit", title: `SEO audit ${new Date().toISOString().slice(0, 10)}`, data, authorEmployeeId: employee.id, taskId: task.id });
    return { status: "completed", summary: `Crawled ${pages.length} page(s); ${Object.values(issueCounts).reduce((a, b) => a + b, 0)} issue instance(s).`, output: { pagesCrawled: pages.length, issueCounts, duplicateTitles } };
  },
};

export const adsReview: Skill = {
  type: "ads.review",
  label: "Google Ads performance review",
  office: { status: "analyzing", location: "marketing_department" },
  requires: ["google_ads"],
  async run() {
    const s = integrationStatuses().find((i) => i.key === "google_ads")!;
    if (!s.configured) {
      return { status: "blocked", reason: `Google Ads is not connected. Required: ${s.envVars.join(", ")} (read-only access to the 4U Ads account). No spend or keyword data will be estimated.` };
    }
    return { status: "blocked", reason: "Google Ads API client is not implemented yet (credentials detected)." };
  },
};

const ContentSchema = z.object({
  title: z.string(),
  format: z.string(),
  body: z.string(),
  targetKeywords: z.array(z.string()),
  claimsUsed: z.array(z.string()).describe("Factual claims about 4U, each from VERIFIED COMPANY FACTS"),
  needsVerification: z.array(z.string()).describe("Technical points that need a human/engineer to verify before publishing"),
});

export const contentDraft: Skill = {
  type: "content.draft",
  label: "Draft marketing content",
  office: { status: "writing", location: "marketing_department" },
  requires: ["anthropic"],
  async run({ db, task, employee }) {
    const brief = typeof task.input.brief === "string" ? task.input.brief : null;
    if (!brief) return { status: "blocked", reason: "No content brief provided (topic, format, audience)." };
    const kb = await getKnowledge(db);
    const c = await generateStructured(
      { db, employeeId: employee.id, taskId: task.id },
      {
        profile: "sales_writing",
        system: `You write B2B technical marketing content for 4U Power Generation FZC (UAE). Only state facts about 4U that are in VERIFIED COMPANY FACTS. General engineering explanations (e.g. prime vs standby) are allowed but must be accurate and conservative; list anything uncertain in needsVerification. No prices, stock or lead times.`,
        prompt: `BRIEF: ${brief}\n\n${knowledgeAsPrompt(kb)}`,
        schema: ContentSchema,
      },
    );
    const approval = await requestApproval(db, {
      action: "publish_content",
      title: `Publish: ${c.title}`,
      summary: `${c.format} by ${employee.name}. Keywords: ${c.targetKeywords.join(", ")}.${c.needsVerification.length ? ` Needs verification: ${c.needsVerification.join("; ")}` : ""}`,
      payload: c,
      requestedByEmployeeId: employee.id,
      taskId: task.id,
    });
    return { status: "waiting_approval", approvalId: approval.id, summary: `Drafted "${c.title}" — awaiting publish approval.`, output: { title: c.title } };
  },
};

const CompetitorSchema = z.object({
  competitors: z.array(
    z.object({
      name: z.string(),
      website: z.string().nullable(),
      productRange: z.string().nullable(),
      brands: z.array(z.string()),
      capacityRange: z.string().nullable(),
      targetIndustries: z.array(z.string()),
      coverage: z.string().nullable(),
      positioning: z.string().nullable(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      sources: z.array(z.string()),
    }),
  ),
});

export const competitorResearch: Skill = {
  type: "competitor.research",
  label: "Competitor intelligence",
  office: { status: "researching", location: "research_department" },
  requires: ["anthropic"],
  async run({ db, task, employee }) {
    const scope = typeof task.input.scope === "string" ? task.input.scope : "diesel generator suppliers and assemblers in the UAE";
    const r = await researchWeb(
      { db, employeeId: employee.id, taskId: task.id },
      {
        system: "You are a market intelligence analyst. Use only public sources you retrieve. Never state a competitor's price, stock or capability without a source URL. Mark opinions as such.",
        prompt: `Profile 3–6 competitors: ${scope}. For each: website, product range, engine brands, capacity range, target industries, geographic coverage, positioning, marketing approach, strengths and weaknesses — each backed by URLs.`,
        maxSearches: 10,
      },
    );
    const s = await generateStructured(
      { db, employeeId: employee.id, taskId: task.id },
      { profile: "research_web", system: "Structure the findings. Use only URLs from ALLOWED SOURCES; drop unsupported claims.", prompt: `REPORT:\n${r.report}\n\nALLOWED SOURCES:\n${[...r.sourceUrls.keys()].join("\n")}`, schema: CompetitorSchema },
    );
    const allowed = new Set(r.sourceUrls.keys());
    const competitors = s.competitors.map((c) => ({ ...c, sources: c.sources.filter((u) => allowed.has(u)) })).filter((c) => c.sources.length > 0);
    await db.insert(reports).values({ kind: "competitor_research", title: `Competitor intelligence: ${scope}`, data: { scope, competitors, searches: r.searches }, authorEmployeeId: employee.id, taskId: task.id });
    return { status: "completed", summary: `${competitors.length} sourced competitor profile(s).`, output: { count: competitors.length } };
  },
};

const PlanSchema = z.object({
  summary: z.string(),
  targetIndustries: z.array(z.object({ industry: z.string(), rationale: z.string() })),
  campaigns: z.array(z.object({ name: z.string(), channel: z.string(), objective: z.string(), proposedBudgetAed: z.number().nullable(), kpi: z.string() })),
  dataGaps: z.array(z.string()),
});

export const marketingPlan: Skill = {
  type: "marketing.plan",
  label: "Marketing strategy & campaign plan",
  office: { status: "analyzing", location: "marketing_department" },
  requires: ["anthropic"],
  async run({ db, task, employee }) {
    const last90 = await funnelMetrics(db, new Date(Date.now() - 90 * 86400_000), new Date());
    const pipe = await pipelineSnapshot(db);
    const integrations = integrationStatuses().filter((i) => ["ga4", "gsc", "google_ads"].includes(i.key));
    const kb = await getKnowledge(db, ["company_profile", "marketing", "competitor"]);
    const plan = await generateStructured(
      { db, employeeId: employee.id, taskId: task.id },
      {
        profile: "reasoning",
        system: "You are the Marketing Director of a UAE B2B diesel generator company. Optimise for qualified RFQs, not clicks. Do not invent market data; list missing data as dataGaps. Budgets are proposals only (approval required).",
        prompt: `INTERNAL FUNNEL (last 90 days, actual): ${JSON.stringify(last90)}\nPIPELINE: ${JSON.stringify(pipe)}\nANALYTICS CONNECTIONS: ${integrations.map((i) => `${i.name}: ${i.configured ? "connected" : "NOT connected"}`).join("; ")}\n${knowledgeAsPrompt(kb)}`,
        schema: PlanSchema,
      },
    );
    for (const c of plan.campaigns) {
      await db.insert(campaigns).values({ name: c.name, channel: c.channel, objective: `${c.objective} — KPI: ${c.kpi}`, status: "draft", proposedBudgetAed: c.proposedBudgetAed?.toFixed(2) ?? null, ownerEmployeeId: employee.id, targetIndustries: plan.targetIndustries.map((t) => t.industry) });
    }
    await db.insert(reports).values({ kind: "marketing_plan", title: "Marketing plan", data: plan, authorEmployeeId: employee.id, taskId: task.id });
    return { status: "completed", summary: `Plan with ${plan.campaigns.length} draft campaign(s); ${plan.dataGaps.length} data gap(s).`, output: plan };
  },
};
