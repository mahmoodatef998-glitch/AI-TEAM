import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createNodeDb } from "../src/lib/db/node";

const { db, pool } = createNodeDb();
await migrate(db as never, { migrationsFolder: "./drizzle" });
console.log("Migrations applied.");
await pool.end();
