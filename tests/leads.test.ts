import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, leadEvidence, leads, messages, tasks } from "@/lib/db/schema";
import { intakeLead, LeadValidationError, normalizeCompanyName, normalizeDomain, qualifyLead } from "@/lib/domain/leads";
import { assignLead } from "@/lib/domain/assignment";
import { agent, createTestDb, strongLead } from "./helpers";

describe("normalization", () => {
  it("strips legal suffixes and punctuation", () => {
    expect(normalizeCompanyName("Gulf Steel Fabrication L.L.C.")).toBe("gulf steel fabrication");
    expect(normalizeCompanyName("The ABC Trading Co. FZE")).toBe("abc trading");
    expect(normalizeCompanyName("Al Futtaim & Sons LLC")).toBe("al futtaim and sons");
  });
  it("normalizes domains from URLs and emails, ignoring free-mail", () => {
    expect(normalizeDomain("https://www.Example.ae/contact")).toBe("example.ae");
    expect(normalizeDomain("sales@example.ae")).toBe("example.ae");
    expect(normalizeDomain("someone@gmail.com")).toBeNull();
  });
});

describe("lead intake & duplicate prevention", () => {
  it("creates company + lead + evidence and queues qualification", async () => {
    const db = await createTestDb();
    const r = await intakeLead(db, strongLead(), await agent(db, "lead_gen_specialist"));
    expect(r.outcome).toBe("created");
    const ev = await db.select().from(leadEvidence).where(eq(leadEvidence.leadId, r.leadId));
    expect(ev.length).toBeGreaterThanOrEqual(2);
    const q = await db.select().from(tasks).where(eq(tasks.type, "lead.qualify"));
    expect(q).toHaveLength(1);
  });

  it("merges a second discovery of the same company (by domain) into the open lead", async () => {
    const db = await createTestDb();
    const a = await agent(db, "lead_gen_specialist");
    const r1 = await intakeLead(db, strongLead(), a);
    const second = strongLead({ name: "GULF STEEL FAB (different spelling)" });
    second.evidence = [{ evidenceType: "news", url: "https://news.example.ae/another", title: "Another article", reliability: "medium" }];
    const r2 = await intakeLead(db, second, a);
    expect(r2.outcome).toBe("merged_into_open_lead");
    expect(r2.leadId).toBe(r1.leadId);
    expect(await db.select().from(companies)).toHaveLength(1);
    expect(await db.select().from(leads)).toHaveLength(1);
    // Qualification task is not duplicated
    expect(await db.select().from(tasks).where(eq(tasks.type, "lead.qualify"))).toHaveLength(1);
  });

  it("matches by normalized name + country when there is no website", async () => {
    const db = await createTestDb();
    const a = await agent(db, "lead_gen_specialist");
    const l1 = strongLead({ website: null, name: "Desert Cold Storage LLC" });
    await intakeLead(db, l1, a);
    const r2 = await intakeLead(db, strongLead({ website: null, name: "Desert Cold Storage L.L.C" }), a);
    expect(r2.outcome).toBe("merged_into_open_lead");
  });

  it("never routes an already-owned account to a new owner; notifies the owner instead", async () => {
    const db = await createTestDb();
    const a = await agent(db, "lead_gen_specialist");
    const r1 = await intakeLead(db, strongLead(), a);
    await qualifyLead(db, r1.leadId, await agent(db, "lead_qualification_specialist"));
    const assigned = await assignLead(db, r1.leadId, await agent(db, "sales_director"));
    const again = strongLead();
    again.evidence = [{ evidenceType: "news", url: "https://news.example.ae/phase2", title: "Phase 2 expansion", reliability: "high" }];
    const r2 = await intakeLead(db, again, a);
    expect(r2.outcome).toBe("existing_account");
    if (r2.outcome === "existing_account") expect(r2.ownerEmployeeId).toBe(assigned.employeeId);
    const [l2] = await db.select().from(leads).where(eq(leads.id, r2.leadId));
    expect(l2.status).toBe("duplicate");
    const msgs = await db.select().from(messages).where(and(eq(messages.toEmployeeId, assigned.employeeId!), eq(messages.kind, "research_share")));
    expect(msgs.length).toBe(1);
  });

  it("rejects leads without a traceable source and contacts without a source URL", async () => {
    const db = await createTestDb();
    const a = await agent(db, "lead_gen_specialist");
    const noSource = strongLead();
    noSource.evidence = [];
    noSource.lead.sourceUrl = null;
    await expect(intakeLead(db, noSource, a)).rejects.toBeInstanceOf(LeadValidationError);
    const badContact = strongLead();
    badContact.contacts = [{ name: "X", sourceUrl: "" }];
    await expect(intakeLead(db, badContact, a)).rejects.toBeInstanceOf(LeadValidationError);
  });

  it("stores collected emails as unverified", async () => {
    const db = await createTestDb();
    const r = await intakeLead(db, strongLead(), await agent(db, "lead_gen_specialist"));
    const { contacts } = await import("@/lib/db/schema");
    const c = await db.select().from(contacts).where(eq(contacts.companyId, r.companyId));
    expect(c[0].emailStatus).toBe("unverified");
  });

  it("qualification routes by score band", async () => {
    const db = await createTestDb();
    const q = await agent(db, "lead_qualification_specialist");
    const r = await intakeLead(db, strongLead(), await agent(db, "lead_gen_specialist"));
    const res = await qualifyLead(db, r.leadId, q);
    expect(res.skipped).toBe(false);
    expect(await db.select().from(tasks).where(eq(tasks.type, "lead.assign"))).toHaveLength(1);

    const weak = strongLead({ name: "Small Cafe", website: "https://smallcafe.example", industry: "other", companySize: null, companySizeVerified: false });
    weak.lead = { ...weak.lead, signalStrength: "potential_requirement", hasActiveProject: false, purchaseTiming: "unknown", capacityKvaMin: null, capacityKvaMax: null };
    weak.contacts = [];
    weak.evidence = [{ evidenceType: "directory", url: "https://dir.example/cafe", title: "Directory", reliability: "low" }];
    weak.lead.sourceUrl = null;
    const w = await intakeLead(db, weak, await agent(db, "lead_gen_specialist"));
    const wr = await qualifyLead(db, w.leadId, q);
    expect(wr.skipped).toBe(false);
    if (!wr.skipped) expect(wr.status).toBe("low_priority");
  });
});
