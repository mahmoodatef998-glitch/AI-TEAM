import { eq } from "drizzle-orm";
import { aiEmployees } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";

export type Employee = typeof aiEmployees.$inferSelect;

export async function getEmployeeByRole(db: DB, roleKey: string): Promise<Employee> {
  const [e] = await db.select().from(aiEmployees).where(eq(aiEmployees.roleKey, roleKey));
  if (!e) throw new Error(`AI employee with role '${roleKey}' not found — run the seed script`);
  return e;
}

export async function getEmployee(db: DB, id: string): Promise<Employee> {
  const [e] = await db.select().from(aiEmployees).where(eq(aiEmployees.id, id));
  if (!e) throw new Error(`AI employee ${id} not found`);
  return e;
}

export async function listSalesExecutives(db: DB): Promise<Employee[]> {
  const rows = await db.select().from(aiEmployees).where(eq(aiEmployees.isSalesExecutive, true));
  return rows.filter((r) => r.active).sort((a, b) => a.code.localeCompare(b.code));
}
