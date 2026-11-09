import { describe, expect, it } from "vitest";
import { analyzeRfq, fullLoadCurrent, lineVoltage, type CatalogueProduct } from "@/lib/domain/rfq";
import { buildKpiPlan, conversionRates } from "@/lib/domain/kpi";
import { createTestDb } from "./helpers";

const product = (o: Partial<CatalogueProduct>): CatalogueProduct => ({
  id: "p", brand: "Cummins", model: "C550", primeKva: 500, standbyKva: 550, frequencyHz: 50, voltage: "400/230", phase: 3, canopy: "soundproof", fuelTankLiters: 1000, maxAmbientC: 50, priceAed: "200000", priceVerified: true, availability: "in_stock", ...o,
});

describe("RFQ technical analysis", () => {
  it("computes full-load current and parses voltages", () => {
    expect(lineVoltage("400/230 V")).toBe(400);
    expect(lineVoltage("11kV")).toBe(11000);
    expect(Math.round(fullLoadCurrent(500, 400))).toBe(722);
  });

  it("lists missing information as customer questions", () => {
    const a = analyzeRfq({ standbyKva: 500 }, []);
    expect(a.missingInfo).toEqual(expect.arrayContaining(["Frequency", "Voltage", "Phase", "Quantity", "ATS"]));
    expect(a.customerQuestions.length).toBeGreaterThanOrEqual(a.missingInfo.length);
    expect(a.catalogueEmpty).toBe(true);
    expect(a.readyForQuotation).toBe(false);
  });

  it("detects specification conflicts and never assumes a 60 Hz conversion", () => {
    const a = analyzeRfq({ primeKva: 600, standbyKva: 500, frequencyHz: 60, voltage: "400/230", phase: 3, ats: true, atsRatingA: 400 }, []);
    expect(a.conflicts.join(" ")).toMatch(/standby is always/);
    expect(a.conflicts.join(" ")).toMatch(/ATS rating 400 A is below/);
    expect(a.warnings.join(" ")).toMatch(/1800 rpm/);
  });

  it("matches only catalogue products that meet the spec, preferring the requested brand", () => {
    const cat = [product({ id: "a", brand: "Perkins", model: "P550", standbyKva: 550 }), product({ id: "b", brand: "Cummins", standbyKva: 560 }), product({ id: "c", standbyKva: 400 }), product({ id: "d", frequencyHz: 60 })];
    const a = analyzeRfq({ quantity: 1, standbyKva: 500, frequencyHz: 50, voltage: "400/230", phase: 3, brandPreference: "Cummins", canopy: "soundproof", fuelTankHours: 8, ats: false, ambientTempC: 45, deliveryLocation: "Dubai", installationRequired: false }, cat);
    expect(a.matches.map((m) => m.product.id)).toEqual(["b", "a"]);
    expect(a.readyForQuotation).toBe(true);
    expect(a.complianceMatrix.find((r) => r.parameter === "Standby rating")!.status).toBe("complies");
  });
});

describe("KPI planning", () => {
  it("labels every figure as an assumption when there is no history", async () => {
    const db = await createTestDb();
    const rates = await conversionRates(db);
    expect(rates.averageDealValueAed.basis).toBe("assumption");
    const plan = buildKpiPlan(500000, rates);
    expect(plan.every((p) => p.basis === "assumption")).toBe(true);
    const won = plan.find((p) => p.metric === "Won deals")!.required;
    const quotes = plan.find((p) => p.metric === "Quotations sent")!.required;
    expect(won).toBe(Math.ceil(500000 / 85000));
    expect(quotes).toBe(Math.ceil(won / 0.2));
  });
});
