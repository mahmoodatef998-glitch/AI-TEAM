import { describe, expect, it } from "vitest";
import { classify, scoreLead, type ScoringInput } from "@/lib/domain/scoring";

const base: ScoringInput = {
  signalStrength: "confirmed_requirement",
  hasActiveProject: true,
  purchaseTiming: "within_3_months",
  capacityKvaMin: 500,
  capacityKvaMax: 1000,
  industry: "manufacturing",
  country: "UAE",
  companySize: "large",
  companySizeVerified: true,
  contacts: [{ name: "A. Buyer", jobTitle: "Procurement Manager", isDecisionMaker: true, email: "p@x.ae", phone: null }],
  evidence: [
    { evidenceType: "tender", reliability: "high", url: "https://t.example/1" },
    { evidenceType: "project_announcement", reliability: "medium", url: "https://n.example/2" },
  ],
};

describe("lead scoring", () => {
  it("scores a fully evidenced confirmed requirement as High Priority", () => {
    const r = scoreLead(base);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.priority).toBe("high_priority");
    expect(r.breakdown).toHaveLength(8);
    expect(r.breakdown.reduce((s, b) => s + b.max, 0)).toBe(100);
  });

  it("does not treat a company that merely operates a factory as a confirmed buyer", () => {
    const r = scoreLead({ ...base, signalStrength: "speculative", hasActiveProject: false, purchaseTiming: "unknown", capacityKvaMin: null, capacityKvaMax: null, contacts: [], evidence: [{ evidenceType: "company_website", reliability: "medium", url: "https://x.example" }] });
    expect(r.breakdown[0].points).toBe(0);
    expect(r.score).toBeLessThan(40);
    expect(r.priority).toBe("low_priority");
  });

  it("downgrades a 'confirmed' claim that has no inquiry/tender/project evidence", () => {
    const r = scoreLead({ ...base, evidence: [{ evidenceType: "company_website", reliability: "high", url: "https://x.example" }] });
    expect(r.effectiveSignal).toBe("potential_requirement");
    expect(r.notes.join(" ")).toMatch(/downgraded/i);
  });

  it("caps at 79 when High Priority is not backed by two evidence items incl. one high-reliability", () => {
    const r = scoreLead({ ...base, evidence: [{ evidenceType: "tender", reliability: "medium", url: "https://t.example/1" }, { evidenceType: "news", reliability: "medium", url: "https://n.example/2" }] });
    expect(r.score).toBe(79);
    expect(r.priority).toBe("qualified");
  });

  it("ignores evidence without a valid URL", () => {
    const r = scoreLead({ ...base, evidence: [{ evidenceType: "tender", reliability: "high", url: "not a url" }] });
    expect(r.breakdown.find((b) => b.criterion === "Reliable supporting evidence")!.points).toBe(0);
    expect(r.effectiveSignal).toBe("potential_requirement");
  });

  it("halves points for unverified company size", () => {
    const r = scoreLead({ ...base, companySizeVerified: false });
    expect(r.breakdown.find((b) => b.criterion === "Relevant company size")!.points).toBe(5);
  });

  it("classifies the four bands", () => {
    expect(classify(80)).toBe("high_priority");
    expect(classify(60)).toBe("qualified");
    expect(classify(40)).toBe("needs_more_research");
    expect(classify(39)).toBe("low_priority");
  });
});
