import { eq } from "drizzle-orm";
import { aiEmployees, departments, knowledgeItems, modelRoutes, schedules } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { DEFAULT_MODEL_ROUTES, DEFAULT_SCHEDULES, DEPARTMENTS, EMPLOYEES } from "./roster";

/**
 * Company facts as stated by 4U management in the project brief. These are the ONLY facts AI
 * employees may state externally until the product catalogue and further data are provided.
 */
const BRIEF_FACTS = [
  { title: "Company identity", content: "4U Power Generation FZC, located in SAIF Zone, Sharjah, United Arab Emirates. Website: https://www.4ugenerators.com/", verified: true },
  { title: "Core business", content: "Supply and assembly of diesel generators from approximately 25 kVA to 2500 kVA.", verified: true },
  { title: "Engine brands", content: "Perkins, Cummins and Volvo generators; other brands when commercially and technically appropriate.", verified: true },
  { title: "Product range", content: "Diesel generators, generator spare parts, Automatic Transfer Switches (ATS), synchronization panels, electrical control panels and generator accessories.", verified: true },
  { title: "Services", content: "Generator installation and commissioning. Technical support and maintenance services where offered (scope to be confirmed by 4U).", verified: false },
];

export async function seedOrganization(db: DB) {
  const deptIds = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const [row] = await db
      .insert(departments)
      .values(d)
      .onConflictDoUpdate({ target: departments.key, set: { name: d.name, description: d.description, officeZone: d.officeZone, kpis: d.kpis } })
      .returning();
    deptIds.set(d.key, row.id);
  }
  const empIds = new Map<string, string>();
  for (const e of EMPLOYEES) {
    const values = {
      code: e.code,
      roleKey: e.roleKey,
      name: e.name,
      title: e.title,
      departmentId: deptIds.get(e.department)!,
      persona: e.persona,
      jobDescription: e.jobDescription,
      responsibilities: e.responsibilities,
      skills: e.skills,
      specialization: e.specialization ?? {},
      targets: e.targets ?? {},
      isSalesExecutive: e.isSalesExecutive ?? false,
      avatarColor: e.avatarColor,
    };
    // Names/personas are editable in the DB; on re-seed only structural fields are refreshed.
    const [row] = await db
      .insert(aiEmployees)
      .values(values)
      .onConflictDoUpdate({
        target: aiEmployees.roleKey,
        set: { skills: values.skills, departmentId: values.departmentId, isSalesExecutive: values.isSalesExecutive, title: values.title },
      })
      .returning();
    empIds.set(e.roleKey, row.id);
  }
  for (const e of EMPLOYEES) {
    if (e.manager) await db.update(aiEmployees).set({ managerId: empIds.get(e.manager)! }).where(eq(aiEmployees.roleKey, e.roleKey));
  }
  for (const s of DEFAULT_SCHEDULES) {
    await db
      .insert(schedules)
      .values({ key: s.key, name: s.name, cron: s.cron, taskType: s.taskType, assigneeRoleKey: s.assigneeRoleKey, input: "input" in s ? { ...s.input } : {} })
      .onConflictDoNothing();
  }
  for (const r of DEFAULT_MODEL_ROUTES) {
    await db.insert(modelRoutes).values({ ...r, effort: r.effort ?? null }).onConflictDoNothing();
  }
  const existing = await db.select({ id: knowledgeItems.id }).from(knowledgeItems).where(eq(knowledgeItems.category, "company_profile")).limit(1);
  if (existing.length === 0) {
    for (const f of BRIEF_FACTS) {
      await db.insert(knowledgeItems).values({
        category: "company_profile",
        title: f.title,
        content: f.content,
        source: "4U management project brief (2026-11-07)",
        verified: f.verified,
        verifiedAt: f.verified ? new Date() : null,
      });
    }
  }
  return { departments: deptIds.size, employees: empIds.size };
}
