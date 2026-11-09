import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Driver-agnostic database handle. Production uses node-postgres; tests use PGlite
 * (in-process PostgreSQL). Transactions are also assignable to this type.
 */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
