import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { accountOwners, companies, contacts, leadEvidence, leads } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { logActivity, type Actor } from "./activity";
import { getEmployeeByRole } from "./employees";
import { sendMessage } from "./messaging";
import { scoreLead, type SignalStrength } from "./scoring";
import { createTask } from "./tasks";

const LEGAL_SUFFIXES = [
  "llc", "l l c", "fzc", "fze", "fzco", "fz llc", "fz", "dmcc", "ltd", "limited", "plc", "inc", "corp",
  "corporation", "co", "company", "est", "establishment", "pjsc", "psc", "wll", "w l l", "spc", "saoc", "bv", "gmbh", "sa",
];

/** Normalize a company name for duplicate detection: case, punctuation and legal suffixes removed. */
export function normalizeCompanyName(name: string): string {
  let n = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'’"()\-_/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of LEGAL_SUFFIXES) {
      if (n.endsWith(" " + s)) {
        n = n.slice(0, -(s.length + 1)).trim();
        changed = true;
      }
    }
  }
  return n.replace(/^the /, "");
}

/** Extract a normalized domain from a URL or email address. Free-mail domains are ignored. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s.includes("@") && !s.includes("/")) s = s.split("@")[1];
  else {
    if (!/^https?:\/\//.test(s)) s = "http://" + s;
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/^www\./, "");
  if (!s.includes(".")) return null;
  const freeMail = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "linkedin.com", "facebook.com"];
  if (freeMail.includes(s)) return null;
  return s;
}

export interface LeadIntakeInput {
  company: {
    name: string;
    website?: string | null;
    country?: string | null;
    city?: string | null;
    industry?: string | null;
    businessActivity?: string | null;
    companySize?: string | null;
    companySizeVerified?: boolean;
    linkedinUrl?: string | null;
    accountType?: string | null;
    odooPartnerId?: number | null;
  };
  contacts?: {
    name?: string | null;
    jobTitle?: string | null;
    isDecisionMaker?: boolean;
    email?: string | null;
    phone?: string | null;
    linkedinUrl?: string | null;
    sourceUrl: string;
  }[];
  evidence?: {
    evidenceType: string;
    url: string;
    title: string;
    excerpt?: string | null;
    publishedAt?: string | null;
    reliability?: "high" | "medium" | "low";
  }[];
  lead: {
    requirementSummary?: string | null;
    capacityKvaMin?: number | null;
    capacityKvaMax?: number | null;
    brandPreference?: string | null;
    signalStrength?: SignalStrength;
    buyingSignal?: string | null;
    hasActiveProject?: boolean;
    purchaseTiming?: string | null;
    recommendedApproach?: string | null;
    source: string;
    sourceUrl?: string | null;
  };
  discoveredByEmployeeId?: string | null;
  createdByUserId?: string | null;
}

export type IntakeOutcome =
  | { outcome: "created"; leadId: string; companyId: string }
  | { outcome: "merged_into_open_lead"; leadId: string; companyId: string }
  | { outcome: "existing_account"; leadId: string; companyId: string; ownerEmployeeId: string };

const isUrl = (u: string | null | undefined) => !!u && /^https?:\/\/\S+$/i.test(u);

export class LeadValidationError extends Error {}

/** Find an existing company by domain, then by normalized name + country, then by normalized name. */
export async function findExistingCompany(db: DB, name: string, website?: string | null, country?: string | null) {
  const domain = normalizeDomain(website);
  if (domain) {
    const [byDomain] = await db.select().from(companies).where(eq(companies.domain, domain)).limit(1);
    if (byDomain) return { company: byDomain, matchedOn: "domain" as const };
  }
  const norm = normalizeCompanyName(name);
  const [byName] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.normalizedName, norm), sql`coalesce(${companies.country}, '') = ${country ?? ""}`))
    .limit(1);
  if (byName) return { company: byName, matchedOn: "name_country" as const };
  // A country-less record with the same name is treated as the same company.
  const [byNameOnly] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.normalizedName, norm), sql`(${companies.country} is null or ${country ?? null}::text is null)`))
    .limit(1);
  if (byNameOnly) return { company: byNameOnly, matchedOn: "name" as const };
  return null;
}

/**
 * Lead intake with duplicate prevention. Never creates a second company for the same domain or
 * name, never creates a second open lead per company, and never routes an already-owned account
 * to a different Sales Executive — new information is merged and the owner is notified instead.
 */
export async function intakeLead(db: DB, input: LeadIntakeInput, actor: Actor): Promise<IntakeOutcome> {
  if (!input.company.name?.trim()) throw new LeadValidationError("Company name is required");
  const evidence = (input.evidence ?? []).filter((e) => isUrl(e.url));
  if (!isUrl(input.lead.sourceUrl) && evidence.length === 0 && input.lead.source !== "inbound_inquiry") {
    throw new LeadValidationError("Every lead needs a traceable source: provide a source URL or at least one evidence item with a URL.");
  }
  for (const c of input.contacts ?? []) {
    if (!isUrl(c.sourceUrl)) throw new LeadValidationError("Every contact detail must have a source URL.");
  }

  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const existing = await findExistingCompany(tx, input.company.name, input.company.website, input.company.country);
    let companyId: string;
    if (existing) {
      companyId = existing.company.id;
      // Fill gaps only — never overwrite existing CRM data with new, possibly weaker data.
      const c = existing.company;
      await tx
        .update(companies)
        .set({
          website: c.website ?? input.company.website ?? null,
          domain: c.domain ?? normalizeDomain(input.company.website),
          city: c.city ?? input.company.city ?? null,
          industry: c.industry ?? input.company.industry ?? null,
          businessActivity: c.businessActivity ?? input.company.businessActivity ?? null,
          companySize: c.companySize ?? input.company.companySize ?? null,
          linkedinUrl: c.linkedinUrl ?? input.company.linkedinUrl ?? null,
          accountType: c.accountType ?? input.company.accountType ?? null,
          odooPartnerId: c.odooPartnerId ?? input.company.odooPartnerId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, c.id));
    } else {
      const [c] = await tx
        .insert(companies)
        .values({
          name: input.company.name.trim(),
          normalizedName: normalizeCompanyName(input.company.name),
          domain: normalizeDomain(input.company.website),
          website: input.company.website ?? null,
          country: input.company.country ?? null,
          city: input.company.city ?? null,
          industry: input.company.industry ?? null,
          businessActivity: input.company.businessActivity ?? null,
          companySize: input.company.companySize ?? null,
          companySizeVerified: input.company.companySizeVerified ?? false,
          linkedinUrl: input.company.linkedinUrl ?? null,
          accountType: input.company.accountType ?? null,
          odooPartnerId: input.company.odooPartnerId ?? null,
        })
        .returning();
      companyId = c.id;
    }

    for (const ct of input.contacts ?? []) {
      // Skip exact duplicate contacts (same email, or same name at same company).
      const dupe = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.companyId, companyId),
            ct.email ? eq(contacts.email, ct.email.toLowerCase()) : ct.name ? eq(contacts.name, ct.name) : sql`false`,
          ),
        )
        .limit(1);
      if (dupe.length) continue;
      await tx.insert(contacts).values({
        companyId,
        name: ct.name ?? null,
        jobTitle: ct.jobTitle ?? null,
        isDecisionMaker: ct.isDecisionMaker ?? false,
        email: ct.email?.toLowerCase() ?? null,
        emailStatus: "unverified", // never present a collected email as verified
        phone: ct.phone ?? null,
        linkedinUrl: ct.linkedinUrl ?? null,
        sourceUrl: ct.sourceUrl,
      });
    }

    const [owner] = await tx.select().from(accountOwners).where(eq(accountOwners.companyId, companyId));
    const [openLead] = await tx
      .select()
      .from(leads)
      .where(and(eq(leads.companyId, companyId), notInArray(leads.status, ["rejected", "duplicate", "assigned"])))
      .limit(1);

    const leadValues = {
      requirementSummary: input.lead.requirementSummary ?? null,
      capacityKvaMin: input.lead.capacityKvaMin ?? null,
      capacityKvaMax: input.lead.capacityKvaMax ?? null,
      brandPreference: input.lead.brandPreference ?? null,
      signalStrength: input.lead.signalStrength ?? "speculative",
      buyingSignal: input.lead.buyingSignal ?? null,
      hasActiveProject: input.lead.hasActiveProject ?? false,
      purchaseTiming: input.lead.purchaseTiming ?? "unknown",
      recommendedApproach: input.lead.recommendedApproach ?? null,
      source: input.lead.source,
      sourceUrl: input.lead.sourceUrl ?? null,
      discoveredByEmployeeId: input.discoveredByEmployeeId ?? null,
      createdByUserId: input.createdByUserId ?? null,
    };

    let leadId: string;
    let outcome: IntakeOutcome;
    if (owner) {
      const [prev] = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.companyId, companyId))
        .orderBy(desc(leads.createdAt))
        .limit(1);
      const [l] = await tx
        .insert(leads)
        .values({ ...leadValues, companyId, status: "duplicate", duplicateOfLeadId: prev?.id ?? null })
        .returning();
      leadId = l.id;
      outcome = { outcome: "existing_account", leadId, companyId, ownerEmployeeId: owner.ownerEmployeeId };
    } else if (openLead) {
      leadId = openLead.id;
      // Merge: keep the stronger / more specific information.
      const rank = { speculative: 0, potential_requirement: 1, strong_buying_signal: 2, confirmed_requirement: 3 } as const;
      const newSignal = leadValues.signalStrength as keyof typeof rank;
      await tx
        .update(leads)
        .set({
          signalStrength: rank[newSignal] > rank[openLead.signalStrength] ? newSignal : openLead.signalStrength,
          requirementSummary: openLead.requirementSummary ?? leadValues.requirementSummary,
          capacityKvaMin: openLead.capacityKvaMin ?? leadValues.capacityKvaMin,
          capacityKvaMax: openLead.capacityKvaMax ?? leadValues.capacityKvaMax,
          brandPreference: openLead.brandPreference ?? leadValues.brandPreference,
          buyingSignal: openLead.buyingSignal ?? leadValues.buyingSignal,
          hasActiveProject: openLead.hasActiveProject || leadValues.hasActiveProject,
          purchaseTiming:
            openLead.purchaseTiming && openLead.purchaseTiming !== "unknown" ? openLead.purchaseTiming : leadValues.purchaseTiming,
          updatedAt: new Date(),
        })
        .where(eq(leads.id, openLead.id));
      outcome = { outcome: "merged_into_open_lead", leadId, companyId };
    } else {
      const [l] = await tx.insert(leads).values({ ...leadValues, companyId, status: "new" }).returning();
      leadId = l.id;
      outcome = { outcome: "created", leadId, companyId };
    }

    for (const e of evidence) {
      await tx.insert(leadEvidence).values({
        leadId,
        evidenceType: e.evidenceType,
        url: e.url,
        title: e.title,
        excerpt: e.excerpt ?? null,
        publishedAt: e.publishedAt ?? null,
        reliability: e.reliability ?? "medium",
        collectedByEmployeeId: actor.type === "agent" ? actor.id : null,
        collectedByUserId: actor.type === "user" ? actor.id : null,
      });
    }
    if (isUrl(input.lead.sourceUrl) && !evidence.some((e) => e.url === input.lead.sourceUrl)) {
      await tx.insert(leadEvidence).values({
        leadId,
        evidenceType: "other",
        url: input.lead.sourceUrl!,
        title: `Lead source (${input.lead.source})`,
        reliability: "medium",
        collectedByEmployeeId: actor.type === "agent" ? actor.id : null,
        collectedByUserId: actor.type === "user" ? actor.id : null,
      });
    }
    return outcome;
  });

  const companyName = input.company.name.trim();
  if (result.outcome === "existing_account") {
    await sendMessage(db, {
      fromEmployeeId: actor.type === "agent" ? actor.id : null,
      fromUserId: actor.type === "user" ? actor.id : null,
      toEmployeeId: result.ownerEmployeeId,
      kind: "research_share",
      subject: `New information on your account: ${companyName}`,
      body: `A new signal was found for ${companyName}, which you already own. It was recorded against your account instead of creating a duplicate lead. Signal: ${input.lead.buyingSignal ?? input.lead.requirementSummary ?? "see evidence"}.`,
      relatedType: "company",
      relatedId: result.companyId,
    });
    await logActivity(db, actor, "lead.duplicate_existing_account", `Duplicate prevented: ${companyName} is already owned`, {
      entityType: "lead",
      entityId: result.leadId,
      detail: { ownerEmployeeId: result.ownerEmployeeId },
    });
  } else {
    await logActivity(
      db,
      actor,
      result.outcome === "created" ? "lead.created" : "lead.merged",
      result.outcome === "created" ? `New lead: ${companyName}` : `New evidence merged into open lead: ${companyName}`,
      { entityType: "lead", entityId: result.leadId },
    );
    const qualifier = await getEmployeeByRole(db, "lead_qualification_specialist");
    await createTask(db, {
      type: "lead.qualify",
      title: `Qualify lead: ${companyName}`,
      assigneeEmployeeId: qualifier.id,
      createdBy: actor,
      relatedType: "lead",
      relatedId: result.leadId,
      priority: 6,
      input: { leadId: result.leadId },
      dedupeKey: `qualify:lead:${result.leadId}`,
    });
  }
  return result;
}

export async function loadLeadForScoring(db: DB, leadId: string) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  const [company] = await db.select().from(companies).where(eq(companies.id, lead.companyId));
  const cts = await db.select().from(contacts).where(eq(contacts.companyId, lead.companyId));
  const ev = await db.select().from(leadEvidence).where(eq(leadEvidence.leadId, leadId));
  return { lead, company, contacts: cts, evidence: ev };
}

/**
 * Score a lead and route it:
 *  ≥60 → qualified, queued for the Sales Director to assign
 *  40–59 → needs more research, queued for the Lead Research Manager
 *  <40 → low priority (kept, not routed)
 */
export async function qualifyLead(db: DB, leadId: string, actor: Actor, opts: { parentTaskId?: string } = {}) {
  const data = await loadLeadForScoring(db, leadId);
  if (["assigned", "duplicate", "rejected"].includes(data.lead.status)) {
    return { skipped: true as const, reason: `Lead is ${data.lead.status}` };
  }
  const result = scoreLead({
    signalStrength: data.lead.signalStrength,
    hasActiveProject: data.lead.hasActiveProject,
    purchaseTiming: data.lead.purchaseTiming,
    capacityKvaMin: data.lead.capacityKvaMin,
    capacityKvaMax: data.lead.capacityKvaMax,
    industry: data.company.industry,
    country: data.company.country,
    companySize: data.company.companySize,
    companySizeVerified: data.company.companySizeVerified,
    contacts: data.contacts,
    evidence: data.evidence,
  });
  const status =
    result.priority === "high_priority" || result.priority === "qualified"
      ? ("qualified" as const)
      : result.priority === "needs_more_research"
        ? ("needs_more_research" as const)
        : ("low_priority" as const);

  await db
    .update(leads)
    .set({
      score: result.score,
      priority: result.priority,
      scoreBreakdown: result.breakdown,
      signalStrength: result.effectiveSignal,
      scoredAt: new Date(),
      status,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, leadId));

  await logActivity(db, actor, "lead.scored", `${data.company.name} scored ${result.score}/100 (${result.priority.replace(/_/g, " ")})`, {
    entityType: "lead",
    entityId: leadId,
    detail: { score: result.score, priority: result.priority, notes: result.notes },
  });

  if (status === "qualified") {
    const director = await getEmployeeByRole(db, "sales_director");
    await sendMessage(db, {
      fromEmployeeId: actor.type === "agent" ? actor.id : null,
      toEmployeeId: director.id,
      kind: "research_share",
      subject: `Qualified lead: ${data.company.name} (${result.score}/100)`,
      body: `${data.company.name}${data.company.country ? ` (${data.company.country})` : ""} scored ${result.score}/100 — ${result.priority.replace(/_/g, " ")}. Signal: ${result.effectiveSignal.replace(/_/g, " ")}. ${data.lead.requirementSummary ?? ""} Evidence items: ${data.evidence.length}. Ready for assignment.`,
      relatedType: "lead",
      relatedId: leadId,
    });
    await createTask(db, {
      type: "lead.assign",
      title: `Assign lead: ${data.company.name}`,
      assigneeEmployeeId: director.id,
      createdBy: actor,
      parentTaskId: opts.parentTaskId ?? null,
      relatedType: "lead",
      relatedId: leadId,
      priority: result.priority === "high_priority" ? 9 : 7,
      input: { leadId },
      dedupeKey: `assign:lead:${leadId}`,
    });
  } else if (status === "needs_more_research") {
    const researcher = await getEmployeeByRole(db, "lead_research_manager");
    await createTask(db, {
      type: "lead.research",
      title: `Research further: ${data.company.name}`,
      description: `Score ${result.score}/100. Missing points: ${result.breakdown
        .filter((b) => b.points < b.max)
        .map((b) => b.criterion)
        .join(", ")}.`,
      assigneeEmployeeId: researcher.id,
      createdBy: actor,
      parentTaskId: opts.parentTaskId ?? null,
      relatedType: "lead",
      relatedId: leadId,
      priority: 4,
      input: { leadId },
      dedupeKey: `research:lead:${leadId}`,
    });
  }
  return { skipped: false as const, ...result, status };
}
