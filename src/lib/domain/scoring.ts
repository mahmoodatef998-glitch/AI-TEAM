/**
 * Evidence-based lead scoring (0–100). Pure and deterministic: the same inputs always
 * produce the same score, and every point is explained.
 *
 * | Criterion                              | Max |
 * |----------------------------------------|----:|
 * | Clear generator requirement            |  25 |
 * | Relevant industry                      |  15 |
 * | Active project or expansion            |  15 |
 * | Identified decision-maker              |  15 |
 * | Relevant company size                  |  10 |
 * | Purchase timing                        |  10 |
 * | Geographic and commercial suitability  |   5 |
 * | Reliable supporting evidence           |   5 |
 *
 * Claims without evidence earn little or nothing — a company that merely operates a factory is
 * NOT a confirmed generator buyer. A score of 80+ additionally requires at least two evidence
 * items, one of them high-reliability; otherwise it is capped at 79.
 */
import type { ScoreBreakdown } from "@/lib/db/schema";
import { DECISION_MAKER_TITLES, INDUSTRIES, MARKETS } from "./taxonomy";

export type SignalStrength = "confirmed_requirement" | "strong_buying_signal" | "potential_requirement" | "speculative";
export type Priority = "high_priority" | "qualified" | "needs_more_research" | "low_priority";

export interface ScoringInput {
  signalStrength: SignalStrength;
  hasActiveProject: boolean;
  purchaseTiming: string | null;
  capacityKvaMin?: number | null;
  capacityKvaMax?: number | null;
  industry: string | null;
  country: string | null;
  companySize: string | null;
  companySizeVerified: boolean;
  contacts: { name: string | null; jobTitle: string | null; isDecisionMaker: boolean; email: string | null; phone: string | null }[];
  evidence: { evidenceType: string; reliability: string; url: string }[];
}

export interface ScoringResult {
  score: number;
  priority: Priority;
  breakdown: ScoreBreakdown;
  /** Signal strength after evidence check (may be downgraded). */
  effectiveSignal: SignalStrength;
  notes: string[];
}

const REQUIREMENT_EVIDENCE = new Set(["customer_inquiry", "tender", "project_announcement", "rfq"]);
const PROJECT_EVIDENCE = new Set(["project_announcement", "tender", "news"]);

export function isDecisionMakerTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return DECISION_MAKER_TITLES.some((k) => t.includes(k));
}

export function classify(score: number): Priority {
  if (score >= 80) return "high_priority";
  if (score >= 60) return "qualified";
  if (score >= 40) return "needs_more_research";
  return "low_priority";
}

export function scoreLead(input: ScoringInput): ScoringResult {
  const breakdown: ScoreBreakdown = [];
  const notes: string[] = [];
  const ev = input.evidence.filter((e) => /^https?:\/\//i.test(e.url));
  if (ev.length < input.evidence.length) notes.push("Evidence items without a valid source URL were ignored.");
  const hasRequirementEvidence = ev.some((e) => REQUIREMENT_EVIDENCE.has(e.evidenceType));
  const hasProjectEvidence = ev.some((e) => PROJECT_EVIDENCE.has(e.evidenceType));

  // 1. Clear generator requirement (25)
  let effectiveSignal = input.signalStrength;
  let req = 0;
  let reqReason = "";
  switch (input.signalStrength) {
    case "confirmed_requirement":
      if (hasRequirementEvidence) {
        req = 25;
        reqReason = "Confirmed requirement backed by inquiry/tender/project evidence.";
      } else {
        effectiveSignal = "potential_requirement";
        req = 8;
        reqReason = "Claimed as confirmed but no inquiry/tender/project evidence — downgraded to potential requirement.";
        notes.push("Signal downgraded: confirmed requirement lacked supporting evidence.");
      }
      break;
    case "strong_buying_signal":
      if (ev.length > 0) {
        req = 18;
        reqReason = "Strong buying signal with supporting evidence.";
      } else {
        effectiveSignal = "potential_requirement";
        req = 8;
        reqReason = "Strong signal claimed without evidence — treated as potential requirement.";
        notes.push("Signal downgraded: strong buying signal lacked evidence.");
      }
      break;
    case "potential_requirement":
      req = 8;
      reqReason = "Potential requirement (plausible need, not confirmed).";
      break;
    default:
      req = 0;
      reqReason = "Speculative — no identified generator need.";
  }
  if (req > 0 && (input.capacityKvaMin || input.capacityKvaMax) && req < 25) {
    req += 2;
    reqReason += " Capacity range identified (+2).";
  }
  breakdown.push({ criterion: "Clear generator requirement", points: req, max: 25, reason: reqReason });

  // 2. Relevant industry (15)
  const ind = input.industry ? INDUSTRIES[input.industry] : undefined;
  const indPts = !ind ? 0 : ind.relevance === "high" ? 15 : ind.relevance === "medium" ? 9 : 0;
  breakdown.push({
    criterion: "Relevant industry",
    points: indPts,
    max: 15,
    reason: ind ? `${ind.label} — ${ind.relevance} generator relevance.` : "Industry unknown.",
  });

  // 3. Active project or expansion (15)
  let projPts = 0;
  let projReason = "No active project or expansion identified.";
  if (input.hasActiveProject && hasProjectEvidence) {
    projPts = 15;
    projReason = "Active project/expansion supported by announcement, tender or news.";
  } else if (input.hasActiveProject) {
    projPts = 5;
    projReason = "Project claimed but not evidenced by an announcement, tender or news source.";
  }
  breakdown.push({ criterion: "Active project or expansion", points: projPts, max: 15, reason: projReason });

  // 4. Identified decision-maker (15)
  const dm = input.contacts.find((c) => c.isDecisionMaker || isDecisionMakerTitle(c.jobTitle));
  let dmPts = 0;
  let dmReason = "No relevant contact identified.";
  if (dm) {
    dmPts = dm.name ? 10 : 6;
    dmReason = `Decision-maker role identified (${dm.jobTitle ?? "role"}${dm.name ? `, ${dm.name}` : ", name unknown"}).`;
    if (dm.email || dm.phone) {
      dmPts += 5;
      dmReason += " Public business contact available.";
    }
  } else if (input.contacts.length > 0) {
    dmPts = 4;
    dmReason = "Contact identified but not a confirmed decision-maker.";
  }
  breakdown.push({ criterion: "Identified decision-maker", points: Math.min(15, dmPts), max: 15, reason: dmReason });

  // 5. Relevant company size (10)
  const sizePtsMap: Record<string, number> = { enterprise: 10, large: 10, medium: 7, small: 3 };
  let sizePts = input.companySize ? sizePtsMap[input.companySize] ?? 0 : 0;
  let sizeReason = input.companySize ? `Company size: ${input.companySize}.` : "Company size unknown.";
  if (sizePts && !input.companySizeVerified) {
    sizePts = Math.floor(sizePts / 2);
    sizeReason += " Not verified — half points.";
  }
  breakdown.push({ criterion: "Relevant company size", points: sizePts, max: 10, reason: sizeReason });

  // 6. Purchase timing (10)
  const timingMap: Record<string, number> = { immediate: 10, within_3_months: 8, within_12_months: 4 };
  const timePts = input.purchaseTiming ? timingMap[input.purchaseTiming] ?? 0 : 0;
  breakdown.push({
    criterion: "Purchase timing",
    points: timePts,
    max: 10,
    reason: input.purchaseTiming && input.purchaseTiming !== "unknown" ? `Timing: ${input.purchaseTiming.replace(/_/g, " ")}.` : "Timing unknown.",
  });

  // 7. Geographic and commercial suitability (5)
  const c = (input.country ?? "").trim().toLowerCase();
  const inList = (l: string[]) => l.some((x) => x.toLowerCase() === c);
  const geoPts = !c ? 0 : inList(MARKETS.primary) || c === "united arab emirates" ? 5 : inList(MARKETS.secondary) ? 4 : inList(MARKETS.export) ? 2 : 1;
  breakdown.push({
    criterion: "Geographic and commercial suitability",
    points: geoPts,
    max: 5,
    reason: c ? `Market: ${input.country}.` : "Country unknown.",
  });

  // 8. Reliable supporting evidence (5)
  const high = ev.filter((e) => e.reliability === "high").length;
  const medium = ev.filter((e) => e.reliability === "medium").length;
  const evPts = ev.length >= 2 && high >= 1 ? 5 : high + medium >= 1 ? 3 : ev.length > 0 ? 1 : 0;
  breakdown.push({
    criterion: "Reliable supporting evidence",
    points: evPts,
    max: 5,
    reason: `${ev.length} evidence item(s): ${high} high, ${medium} medium reliability.`,
  });

  let score = breakdown.reduce((s, b) => s + b.points, 0);
  if (score >= 80 && !(ev.length >= 2 && high >= 1)) {
    notes.push("Capped at 79: High Priority requires at least two evidence items including one high-reliability source.");
    score = 79;
  }
  score = Math.max(0, Math.min(100, score));
  return { score, priority: classify(score), breakdown, effectiveSignal, notes };
}
