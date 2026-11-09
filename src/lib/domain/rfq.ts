/**
 * Technical RFQ analysis for diesel generator sets — deterministic engineering checks.
 *
 * Never assumes a frequency/voltage change is possible, never invents a rating or price.
 * Product matching uses ONLY the approved `products` catalogue; if it is empty the analysis
 * says so instead of guessing.
 */
import type { RfqRequirement } from "@/lib/db/schema";

export interface CatalogueProduct {
  id: string;
  brand: string;
  model: string;
  primeKva: number | null;
  standbyKva: number | null;
  frequencyHz: number | null;
  voltage: string | null;
  phase: number | null;
  canopy: string | null;
  fuelTankLiters: number | null;
  maxAmbientC: number | null;
  priceAed: string | null;
  priceVerified: boolean;
  availability: string | null;
}

export interface ComplianceRow {
  parameter: string;
  required: string;
  offered: string;
  status: "complies" | "deviation" | "to_confirm" | "not_specified";
  note?: string;
}

export interface RfqAnalysis {
  missingInfo: string[];
  conflicts: string[];
  warnings: string[];
  customerQuestions: string[];
  fullLoadCurrentA: number | null;
  matches: { product: CatalogueProduct; fitNote: string; ratingMarginPct: number }[];
  complianceMatrix: ComplianceRow[];
  readyForQuotation: boolean;
  catalogueEmpty: boolean;
}

/** Parse line-to-line voltage from strings like "400/230", "415V", "480/277 V", "11kV". */
export function lineVoltage(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = v.toLowerCase().replace(/\s/g, "");
  const kv = s.match(/^(\d+(?:\.\d+)?)kv/);
  if (kv) return Number(kv[1]) * 1000;
  const m = s.match(/(\d{3,5})/);
  return m ? Number(m[1]) : null;
}

/** Three-phase full-load current: I = S / (√3 · V_LL). Single-phase: I = S / V. */
export function fullLoadCurrent(kva: number, voltageLL: number, phase = 3): number {
  return phase === 1 ? (kva * 1000) / voltageLL : (kva * 1000) / (Math.sqrt(3) * voltageLL);
}

const COMMON_50HZ = [380, 400, 415, 220, 230, 240];
const COMMON_60HZ = [208, 220, 380, 440, 460, 480, 600, 120, 240];

export function analyzeRfq(req: RfqRequirement, catalogue: CatalogueProduct[]): RfqAnalysis {
  const missing: string[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const questions: string[] = [];

  const ask = (field: string, q: string) => {
    missing.push(field);
    questions.push(q);
  };
  if (!req.primeKva && !req.standbyKva) ask("Power rating", "What is the required rating in kVA, and is it Prime (continuous/variable load) or Standby (emergency) duty?");
  else if (req.primeKva && !req.standbyKva && !req.application) warnings.push("Prime rating given without application — confirm duty cycle (prime vs continuous).");
  if (!req.frequencyHz) ask("Frequency", "Is the supply 50 Hz or 60 Hz?");
  if (!req.voltage) ask("Voltage", "What output voltage is required (e.g. 400/230 V)?");
  if (!req.phase) ask("Phase", "Three-phase or single-phase output?");
  if (!req.quantity) ask("Quantity", "How many generator sets are required?");
  if (!req.canopy) ask("Enclosure", "Open skid or soundproof canopy? Any noise limit (dB(A) @ 7 m)?");
  if (req.fuelTankHours == null && req.fuelTankLiters == null) ask("Fuel autonomy", "Required fuel autonomy in hours (base tank), and is an external or double-wall tank required?");
  if (req.ats == null) ask("ATS", "Is an Automatic Transfer Switch required? If yes, what rating and pole configuration?");
  if (req.ambientTempC == null) ask("Site ambient temperature", "What is the maximum site ambient temperature and altitude (for derating)?");
  if (!req.deliveryLocation) ask("Delivery location", "What is the delivery location and required delivery terms (Ex-works / DAP / installed)?");
  if (req.installationRequired == null) questions.push("Is installation and commissioning by 4U required?");

  // ── conflicts ──
  if (req.primeKva && req.standbyKva && req.primeKva > req.standbyKva) {
    conflicts.push(`Prime rating (${req.primeKva} kVA) exceeds standby rating (${req.standbyKva} kVA) — standby is always ≥ prime.`);
  }
  for (const k of [req.primeKva, req.standbyKva]) if (k != null && k <= 0) conflicts.push("Rating must be a positive kVA value.");
  if (req.frequencyHz && ![50, 60].includes(req.frequencyHz)) conflicts.push(`Unusual frequency ${req.frequencyHz} Hz — confirm.`);
  const vll = lineVoltage(req.voltage);
  if (req.frequencyHz && vll) {
    const common = req.frequencyHz === 50 ? COMMON_50HZ : COMMON_60HZ;
    if (!common.includes(vll) && vll < 1000) warnings.push(`${req.voltage} at ${req.frequencyHz} Hz is not a standard combination — verify with the customer and alternator data.`);
  }
  if (req.frequencyHz === 60) {
    warnings.push("60 Hz requires an 1800 rpm engine/alternator rating. Do not assume a 50 Hz model can be converted — verify engine, alternator, rating and manufacturer limits.");
  }
  const kva = req.standbyKva ?? req.primeKva ?? null;
  if (req.phase === 1 && kva && kva > 50) conflicts.push(`Single-phase at ${kva} kVA is outside typical single-phase generator range — confirm phase.`);
  if (req.synchronization && (req.quantity ?? 1) < 2) {
    warnings.push("Synchronisation requested with a single set — confirm whether it syncs with the grid or existing generators.");
    questions.push("Synchronisation: with the utility grid, with existing generators (make/model/controller), or between new sets?");
  }
  let flc: number | null = null;
  if (kva && vll) {
    flc = Math.round(fullLoadCurrent(kva, vll, req.phase ?? 3));
    if (req.ats && req.atsRatingA && req.atsRatingA < flc) {
      conflicts.push(`ATS rating ${req.atsRatingA} A is below the generator full-load current ≈ ${flc} A at ${vll} V.`);
    }
  }
  if (req.ambientTempC != null && req.ambientTempC > 50) {
    warnings.push(`Ambient ${req.ambientTempC} °C exceeds typical 40–50 °C ratings — derating and radiator/cooling sizing must be confirmed with the manufacturer.`);
  }

  // ── product matching ──
  const catalogueEmpty = catalogue.length === 0;
  const matches: RfqAnalysis["matches"] = [];
  if (!catalogueEmpty && kva) {
    const useStandby = req.standbyKva != null;
    for (const p of catalogue) {
      const rating = useStandby ? p.standbyKva : p.primeKva;
      if (rating == null || rating < kva) continue;
      if (rating > kva * 1.3) continue; // avoid gross oversizing
      if (req.frequencyHz && p.frequencyHz && p.frequencyHz !== req.frequencyHz) continue;
      if (req.phase && p.phase && p.phase !== req.phase) continue;
      if (vll && p.voltage && lineVoltage(p.voltage) !== vll) continue;
      const margin = Math.round(((rating - kva) / kva) * 100);
      const brandOk = !req.brandPreference || p.brand.toLowerCase().includes(req.brandPreference.toLowerCase());
      matches.push({
        product: p,
        ratingMarginPct: margin,
        fitNote: `${p.brand} ${p.model}: ${rating} kVA ${useStandby ? "standby" : "prime"} (+${margin}%)${brandOk ? "" : " — not the preferred brand"}${p.priceVerified ? "" : " — price not verified"}`,
      });
    }
    matches.sort((a, b) => {
      const pa = !req.brandPreference || a.product.brand.toLowerCase().includes(req.brandPreference.toLowerCase()) ? 0 : 1;
      const pb = !req.brandPreference || b.product.brand.toLowerCase().includes(req.brandPreference.toLowerCase()) ? 0 : 1;
      return pa - pb || a.ratingMarginPct - b.ratingMarginPct;
    });
  }
  if (catalogueEmpty) warnings.push("Approved product catalogue is empty — technical matching and pricing are not possible until 4U's catalogue is loaded.");
  else if (kva && matches.length === 0) warnings.push("No catalogue product meets the requirement — escalate to the technical team.");

  // ── compliance matrix against best match ──
  const best = matches[0]?.product;
  const row = (parameter: string, required: string | null | undefined, offered: string | null | undefined, ok?: boolean, note?: string): ComplianceRow => ({
    parameter,
    required: required ?? "—",
    offered: offered ?? "—",
    status: required == null || required === "" ? "not_specified" : !best || offered == null ? "to_confirm" : ok ? "complies" : "deviation",
    note,
  });
  const matrix: ComplianceRow[] = [
    row("Standby rating", req.standbyKva != null ? `${req.standbyKva} kVA` : null, best?.standbyKva != null ? `${best.standbyKva} kVA` : null, !!(best?.standbyKva && req.standbyKva && best.standbyKva >= req.standbyKva)),
    row("Prime rating", req.primeKva != null ? `${req.primeKva} kVA` : null, best?.primeKva != null ? `${best.primeKva} kVA` : null, !!(best?.primeKva && req.primeKva && best.primeKva >= req.primeKva)),
    row("Frequency", req.frequencyHz ? `${req.frequencyHz} Hz` : null, best?.frequencyHz ? `${best.frequencyHz} Hz` : null, best?.frequencyHz === req.frequencyHz),
    row("Voltage", req.voltage, best?.voltage, lineVoltage(best?.voltage) === vll),
    row("Phase", req.phase ? `${req.phase}-phase` : null, best?.phase ? `${best.phase}-phase` : null, best?.phase === req.phase),
    row("Brand", req.brandPreference, best?.brand, !!(best && req.brandPreference && best.brand.toLowerCase().includes(req.brandPreference.toLowerCase()))),
    row("Enclosure", req.canopy, best?.canopy, !!(best?.canopy && req.canopy && best.canopy.toLowerCase().includes(req.canopy.toLowerCase().split(" ")[0]))),
    row("Max ambient", req.ambientTempC != null ? `${req.ambientTempC} °C` : null, best?.maxAmbientC != null ? `${best.maxAmbientC} °C` : null, !!(best?.maxAmbientC != null && req.ambientTempC != null && best.maxAmbientC >= req.ambientTempC)),
    row("ATS", req.ats == null ? null : req.ats ? `Required${req.atsRatingA ? ` (${req.atsRatingA} A)` : ""}` : "Not required", null, false, req.ats ? `Generator FLC ≈ ${flc ?? "?"} A` : undefined),
    row("Synchronisation", req.synchronization == null ? null : req.synchronization ? "Required" : "Not required", null, false),
  ];

  const ready = missing.length === 0 && conflicts.length === 0 && !!best && best.priceVerified && best.priceAed != null;
  return {
    missingInfo: missing,
    conflicts,
    warnings,
    customerQuestions: questions,
    fullLoadCurrentA: flc,
    matches: matches.slice(0, 5),
    complianceMatrix: matrix,
    readyForQuotation: ready,
    catalogueEmpty,
  };
}
