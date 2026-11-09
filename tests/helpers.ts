import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { seedOrganization } from "@/lib/org/seed";
import { getEmployeeByRole } from "@/lib/domain/employees";
import type { LeadIntakeInput } from "@/lib/domain/leads";

/** Fresh in-process PostgreSQL with the real migrations and the org seed applied. */
export async function createTestDb(): Promise<DB> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
  await seedOrganization(db);
  return db;
}

export async function agent(db: DB, roleKey: string) {
  const e = await getEmployeeByRole(db, roleKey);
  return { type: "agent" as const, id: e.id };
}

/** A well-evidenced lead that should score High Priority. */
export function strongLead(overrides: Partial<LeadIntakeInput["company"]> = {}): LeadIntakeInput {
  return {
    company: {
      name: "Gulf Steel Fabrication LLC",
      website: "https://www.gulfsteel-example.ae",
      country: "UAE",
      city: "Abu Dhabi",
      industry: "manufacturing",
      companySize: "large",
      companySizeVerified: true,
      accountType: "end_user",
      ...overrides,
    },
    contacts: [
      { name: "Procurement Team", jobTitle: "Procurement Manager", isDecisionMaker: true, email: "procurement@gulfsteel-example.ae", sourceUrl: "https://www.gulfsteel-example.ae/contact" },
    ],
    evidence: [
      { evidenceType: "tender", url: "https://tenders.example.gov.ae/t/123", title: "Tender: 2 x 500 kVA standby generators", reliability: "high" },
      { evidenceType: "project_announcement", url: "https://news.example.ae/gulfsteel-expansion", title: "New factory expansion in KIZAD", reliability: "medium" },
    ],
    lead: {
      requirementSummary: "2 x 500 kVA standby generators for new factory",
      capacityKvaMin: 500,
      capacityKvaMax: 1000,
      signalStrength: "confirmed_requirement",
      buyingSignal: "Public tender for standby generators",
      hasActiveProject: true,
      purchaseTiming: "within_3_months",
      source: "tender_portal",
      sourceUrl: "https://tenders.example.gov.ae/t/123",
    },
  };
}
