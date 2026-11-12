// Non-Next entry point (worker, scripts). Same as index.ts without the server-only guard.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import type { DB } from "./types";

export function createNodeDb(url = process.env.DATABASE_URL): { db: DB; pool: Pool } {
  if (!url) throw new Error("DATABASE_URL is not configured");
  const pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10_000 });
  return { db: drizzle(pool, { schema }) as unknown as DB, pool };
}
