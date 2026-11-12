import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import type { DB } from "./types";

const globalForDb = globalThis as unknown as { __pool?: Pool; __db?: DB };

export function getDb(): DB {
  if (!globalForDb.__db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    // Fail fast instead of hanging until the function timeout when the host is unreachable.
    globalForDb.__pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10_000 });
    globalForDb.__db = drizzle(globalForDb.__pool, { schema }) as unknown as DB;
  }
  return globalForDb.__db;
}

export { schema };
export type { DB };
