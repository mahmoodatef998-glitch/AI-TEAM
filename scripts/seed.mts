import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createNodeDb } from "../src/lib/db/node";
import { users } from "../src/lib/db/schema";
import { hashPassword } from "../src/lib/auth/password";
import { seedOrganization } from "../src/lib/org/seed";

const { db, pool } = createNodeDb();
const r = await seedOrganization(db);
console.log(`Seeded ${r.departments} departments and ${r.employees} AI employees (no customers, leads or sales data are seeded).`);

const email = (process.env.ADMIN_EMAIL ?? "admin@4ugenerators.local").toLowerCase();
const [existing] = await db.select().from(users).where(eq(users.email, email));
if (!existing) {
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");
  await db.insert(users).values({ email, name: process.env.ADMIN_NAME ?? "Administrator", passwordHash: await hashPassword(password), role: "admin" });
  console.log(`Admin user created: ${email}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Generated password (shown once): ${password}`);
} else {
  console.log(`Admin user ${email} already exists.`);
}
await pool.end();
