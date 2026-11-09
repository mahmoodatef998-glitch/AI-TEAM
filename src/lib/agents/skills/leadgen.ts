import { eq } from "drizzle-orm";
import { z } from "zod";
import { companies, contacts, leadEvidence, leads } from "@/lib/db/schema";
import { generateStructured, researchWeb } from "@/lib/ai/router";
import { getEmployeeByRole } from "@/lib/domain/employees";
import { intakeLead, loadLeadForScoring, normalizeDomain, qualifyLead } from "@/lib/domain/leads";
import { sendMessage } from "@/lib/domain/messaging";
import { INDUSTRIES } from "@/lib/domain/taxonomy";
import { createTask } from "@/lib/domain/tasks";
import { findOdooPartner, odooConfig } from "@/lib/integrations/odoo";
import type { Skill } from "../types";
import { NonRetryableError } from "../types";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const INDUSTRY_KEYS = Object.keys(INDUSTRIES) as [string, ...string[]];

const RESEARCH_RULES = `You research B2B prospects for 4U Power Generation FZC, a diesel generator supplier in Sharjah, UAE (approx. 25–2500 kVA; Perkins, Cummins, Volvo and other engines; ATS, synchronisation and control panels; installation and commissioning).
Use ONLY legally accessible public sources found with the web search tool: company websites, public tender portals, project announcements, news, business directories, public LinkedIn company pages.
Hard rules:
- Never fabricate companies, people, emails or phone numbers. Only report contact details that appear verbatim on a page you retrieved, and give that page's URL.
- Every claim needs a source URL you actually retrieved.
- Distinguish: confirmed requirement (explicit generator need/tender/RFQ) vs strong buying signal (new facility/expansion/project with power needs) vs potential requirement (operates facilities that typically need backup power) vs speculative.
- A company merely operating a factory is NOT a confirmed generator buyer.
- Do not bypass logins, paywalls or access restrictions. Do not collect private personal information.`;

const EvidenceSchema = z.object({
  url: z.string(),
  title: z.string(),
  excerpt: z.string().describe("Short quote or paraphrase supporting the claim"),
  evidenceType: z.enum(["project_announcement", "tender", "company_website", "news", "directory", "linkedin", "other"]),
  reliability: z.enum(["high", "medium", "low"]),
});
const ContactSchema = z.object({
  name: z.string().nullable(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable().describe("Only if published on the source page"),
  phone: z.string().nullable().describe("Only if published on the source page"),
  sourceUrl: z.string(),
});
const CandidateSchema = z.object({
  companyName: z.string(),
  website: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  industry: z.enum(INDUSTRY_KEYS),
  accountType: z.enum(["end_user", "contractor", "reseller", "consultant", "key_account"]).nullable(),
  businessActivity: z.string().nullable(),
  requirementSummary: z.string().describe("What generator need may exist, and why"),
  capacityKvaMin: z.number().nullable(),
  capacityKvaMax: z.number().nullable(),
  signalStrength: z.enum(["confirmed_requirement", "strong_buying_signal", "potential_requirement", "speculative"]),
  buyingSignal: z.string().nullable(),
  hasActiveProject: z.boolean(),
  purchaseTiming: z.enum(["immediate", "within_3_months", "within_12_months", "unknown"]),
  recommendedApproach: z.string(),
  evidence: z.array(EvidenceSchema),
  contacts: z.array(ContactSchema),
});

/** Keep only evidence/contacts whose URLs the search tool actually returned. */
function verifyAgainstSources<T extends { url?: string; sourceUrl?: string }>(items: T[], sources: Map<string, string>) {
  const norm = (u: string) => u.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
  const known = new Set([...sources.keys()].map(norm));
  const kept = items.filter((i) => known.has(norm(i.url ?? i.sourceUrl ?? "")));
  return { kept, dropped: items.length - kept.length };
}

export const leadQualify: Skill = {
  type: "lead.qualify",
  label: "Score and route lead",
  office: { status: "analyzing", location: "lead_generation_department" },
  async run({ db, task, actor }) {
    const leadId = str(task.input.leadId);
    if (!leadId) throw new NonRetryableError("leadId missing");
    const r = await qualifyLead(db, leadId, actor, { parentTaskId: task.id });
    if (r.skipped) return { status: "completed", summary: `Skipped: ${r.reason}` };
    return {
      status: "completed",
      summary: `Scored ${r.score}/100 (${r.priority.replace(/_/g, " ")}) → ${r.status.replace(/_/g, " ")}`,
      output: { score: r.score, priority: r.priority, breakdown: r.breakdown, notes: r.notes },
    };
  },
};

export const leadDiscover: Skill = {
  type: "lead.discover",
  label: "Discover prospects from public sources",
  office: { status: "researching", location: "lead_generation_department" },
  requires: ["anthropic"],
  async run({ db, task, employee, actor, progress }) {
    const segment = str(task.input.segment) ?? "companies in the UAE with new facilities, projects or expansions that need diesel backup or prime power";
    const country = str(task.input.country) ?? "UAE";
    const max = Math.min(10, Number(task.input.maxCandidates ?? 5));
    await progress(10, "Searching public sources");
    const research = await researchWeb(
      { db, employeeId: employee.id, taskId: task.id },
      {
        system: RESEARCH_RULES,
        prompt: `Find up to ${max} REAL companies in ${country} matching this segment: ${segment}.
For each: company name, website, city, industry, what project/expansion/tender indicates a generator need, indicative capacity if stated, the relevant decision-maker role (procurement / MEP / projects / facilities), any PUBLIC business contact with its page URL, and the source URLs. Prefer recent (last 12 months) announcements and tenders.`,
        maxSearches: 10,
      },
    );
    if (research.sourceUrls.size === 0) return { status: "completed", summary: "Search returned no sources; no leads recorded.", output: { report: research.report } };
    await progress(55, "Structuring findings");
    const { candidates } = await generateStructured(
      { db, employeeId: employee.id, taskId: task.id },
      {
        profile: "research_web",
        system: `${RESEARCH_RULES}\nConvert the research report into structured candidates. Use only URLs from the ALLOWED SOURCES list. Omit any candidate without at least one allowed source.`,
        prompt: `RESEARCH REPORT:\n${research.report}\n\nALLOWED SOURCES:\n${[...research.sourceUrls].map(([u, t]) => `- ${u} (${t})`).join("\n")}`,
        schema: z.object({ candidates: z.array(CandidateSchema) }),
      },
    );
    const outcomes = [];
    let droppedEvidence = 0;
    for (const [i, c] of candidates.slice(0, max).entries()) {
      const ev = verifyAgainstSources(c.evidence, research.sourceUrls);
      const ct = verifyAgainstSources(c.contacts, research.sourceUrls);
      droppedEvidence += ev.dropped + ct.dropped;
      if (ev.kept.length === 0) {
        outcomes.push({ company: c.companyName, outcome: "rejected_no_verified_source" });
        continue;
      }
      let odooPartnerId: number | null = null;
      if (odooConfig()) {
        try {
          odooPartnerId = (await findOdooPartner(c.companyName, normalizeDomain(c.website)))?.id ?? null;
        } catch {
          /* Odoo lookup is best-effort; local duplicate checks still apply */
        }
      }
      const r = await intakeLead(
        db,
        {
          company: {
            name: c.companyName,
            website: c.website,
            country: c.country ?? country,
            city: c.city,
            industry: c.industry,
            accountType: c.accountType,
            businessActivity: c.businessActivity,
            odooPartnerId,
          },
          contacts: ct.kept.map((x) => ({ ...x, isDecisionMaker: false })),
          evidence: ev.kept,
          lead: {
            requirementSummary: c.requirementSummary,
            capacityKvaMin: c.capacityKvaMin,
            capacityKvaMax: c.capacityKvaMax,
            signalStrength: c.signalStrength,
            buyingSignal: c.buyingSignal,
            hasActiveProject: c.hasActiveProject,
            purchaseTiming: c.purchaseTiming,
            recommendedApproach: c.recommendedApproach,
            source: "web_research",
            sourceUrl: ev.kept[0].url,
          },
          discoveredByEmployeeId: employee.id,
        },
        actor,
      );
      outcomes.push({ company: c.companyName, ...r, odooPartnerId });
      await progress(55 + ((i + 1) / candidates.length) * 40);
    }
    const created = outcomes.filter((o) => "outcome" in o && o.outcome === "created").length;
    const manager = await getEmployeeByRole(db, "lead_research_manager");
    await sendMessage(db, {
      fromEmployeeId: employee.id,
      toEmployeeId: manager.id,
      kind: "report",
      subject: `Discovery run: ${created} new lead(s)`,
      body: `Segment: ${segment} (${country}). ${research.searches} searches, ${research.sourceUrls.size} sources. ${created} new, ${outcomes.length - created} merged/duplicate/rejected. ${droppedEvidence} unverifiable URL(s) discarded.`,
      taskId: task.id,
    });
    return {
      status: "completed",
      summary: `${created} new lead(s) from ${research.sourceUrls.size} sources; ${droppedEvidence} unverifiable URL(s) discarded.`,
      output: { outcomes, searches: research.searches, droppedEvidence },
    };
  },
};

const ResearchSchema = z.object({
  summary: z.string(),
  industry: z.enum(INDUSTRY_KEYS).nullable(),
  companySize: z.enum(["small", "medium", "large", "enterprise"]).nullable(),
  companySizeEvidenceUrl: z.string().nullable(),
  signalStrength: z.enum(["confirmed_requirement", "strong_buying_signal", "potential_requirement", "speculative"]),
  buyingSignal: z.string().nullable(),
  hasActiveProject: z.boolean(),
  purchaseTiming: z.enum(["immediate", "within_3_months", "within_12_months", "unknown"]),
  capacityKvaMin: z.number().nullable(),
  capacityKvaMax: z.number().nullable(),
  evidence: z.array(EvidenceSchema),
  contacts: z.array(ContactSchema.extend({ isDecisionMaker: z.boolean() })),
});

export const leadResearch: Skill = {
  type: "lead.research",
  label: "Research lead and gather evidence",
  office: { status: "researching", location: "research_department" },
  requires: ["anthropic"],
  async run({ db, task, employee, actor, progress }) {
    const leadId = str(task.input.leadId);
    if (!leadId) throw new NonRetryableError("leadId missing");
    const data = await loadLeadForScoring(db, leadId);
    const focus = str(task.input.focus);
    await progress(10, `Researching ${data.company.name}`);
    const research = await researchWeb(
      { db, employeeId: employee.id, taskId: task.id },
      {
        system: RESEARCH_RULES,
        prompt: `Research ${data.company.name}${data.company.website ? ` (${data.company.website})` : ""}${data.company.country ? `, ${data.company.country}` : ""}.
Known so far: ${data.lead.requirementSummary ?? "nothing specific"}. Existing evidence: ${data.evidence.map((e) => e.url).join(", ") || "none"}.
${focus === "decision_maker" ? "PRIORITY: identify the procurement / MEP / projects / facilities decision-maker and any PUBLIC business contact (with page URL)." : "Find: business activity, company size (with source), current projects/expansions/tenders with power needs, purchase timing, indicative generator capacity, and relevant decision-maker roles with public business contacts."}`,
        maxSearches: 8,
      },
    );
    await progress(60, "Structuring evidence");
    const f = await generateStructured(
      { db, employeeId: employee.id, taskId: task.id },
      {
        profile: "research_web",
        system: `${RESEARCH_RULES}\nStructure the findings. Use only URLs from ALLOWED SOURCES.`,
        prompt: `COMPANY: ${data.company.name}\nREPORT:\n${research.report}\n\nALLOWED SOURCES:\n${[...research.sourceUrls].map(([u, t]) => `- ${u} (${t})`).join("\n") || "(none)"}`,
        schema: ResearchSchema,
      },
    );
    const ev = verifyAgainstSources(f.evidence, research.sourceUrls);
    const ct = verifyAgainstSources(f.contacts, research.sourceUrls);
    const existingUrls = new Set(data.evidence.map((e) => e.url));
    for (const e of ev.kept.filter((e) => !existingUrls.has(e.url))) {
      await db.insert(leadEvidence).values({ leadId, ...e, collectedByEmployeeId: employee.id });
    }
    for (const c of ct.kept) {
      const dupe = data.contacts.some((x) => (c.email && x.email === c.email.toLowerCase()) || (c.name && x.name === c.name));
      if (!dupe) {
        await db.insert(contacts).values({
          companyId: data.company.id,
          name: c.name,
          jobTitle: c.jobTitle,
          isDecisionMaker: c.isDecisionMaker,
          email: c.email?.toLowerCase() ?? null,
          emailStatus: "unverified",
          phone: c.phone,
          sourceUrl: c.sourceUrl,
        });
      }
    }
    const sizeVerified = !!f.companySizeEvidenceUrl && research.sourceUrls.has(f.companySizeEvidenceUrl);
    await db
      .update(companies)
      .set({
        industry: data.company.industry ?? f.industry,
        companySize: data.company.companySizeVerified ? data.company.companySize : (f.companySize ?? data.company.companySize),
        companySizeVerified: data.company.companySizeVerified || sizeVerified,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, data.company.id));
    const rank = { speculative: 0, potential_requirement: 1, strong_buying_signal: 2, confirmed_requirement: 3 } as const;
    await db
      .update(leads)
      .set({
        signalStrength: rank[f.signalStrength] > rank[data.lead.signalStrength] && ev.kept.length > 0 ? f.signalStrength : data.lead.signalStrength,
        buyingSignal: data.lead.buyingSignal ?? f.buyingSignal,
        hasActiveProject: data.lead.hasActiveProject || (f.hasActiveProject && ev.kept.length > 0),
        purchaseTiming: data.lead.purchaseTiming !== "unknown" && data.lead.purchaseTiming ? data.lead.purchaseTiming : f.purchaseTiming,
        capacityKvaMin: data.lead.capacityKvaMin ?? f.capacityKvaMin,
        capacityKvaMax: data.lead.capacityKvaMax ?? f.capacityKvaMax,
        requirementSummary: data.lead.requirementSummary ?? f.summary,
        status: data.lead.status === "assigned" ? "assigned" : "researching",
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId));
    const requester = str(task.input.requestedBy);
    if (requester) {
      await sendMessage(db, {
        fromEmployeeId: employee.id,
        toEmployeeId: requester,
        kind: "research_share",
        subject: `Research update: ${data.company.name}`,
        body: `${f.summary}\nNew evidence: ${ev.kept.length}. Contacts found: ${ct.kept.length} (all unverified until confirmed). ${ev.dropped + ct.dropped} unverifiable URL(s) discarded.`,
        relatedType: "lead",
        relatedId: leadId,
      });
    }
    if (data.lead.status !== "assigned") {
      const qualifier = await getEmployeeByRole(db, "lead_qualification_specialist");
      await createTask(db, {
        type: "lead.qualify",
        title: `Re-score after research: ${data.company.name}`,
        assigneeEmployeeId: qualifier.id,
        createdBy: actor,
        parentTaskId: task.id,
        relatedType: "lead",
        relatedId: leadId,
        input: { leadId },
        dedupeKey: `qualify:lead:${leadId}`,
      });
    }
    return {
      status: "completed",
      summary: `${ev.kept.length} evidence item(s), ${ct.kept.length} contact(s) for ${data.company.name}; ${ev.dropped + ct.dropped} unverifiable URL(s) discarded.`,
      output: { summary: f.summary, evidenceAdded: ev.kept.length, contactsFound: ct.kept.length },
    };
  },
};
