import { sql } from "drizzle-orm";
import type { DB } from "./types";

/**
 * Database connectivity diagnostics for /api/health and the login page.
 * Nothing here ever returns the password from DATABASE_URL.
 */

export type DatabaseUrlSummary =
  | { configured: false; warnings: string[] }
  | {
      configured: true;
      host: string;
      port: string;
      user: string;
      database: string;
      sslmode: string | null;
      libpqCompat: boolean;
      hasPassword: boolean;
      warnings: string[];
    };

export function describeDatabaseUrl(raw: string | undefined): DatabaseUrlSummary {
  if (!raw) return { configured: false, warnings: ["DATABASE_URL is not set for this environment. Add it, then redeploy."] };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { configured: false, warnings: ["DATABASE_URL is not a valid URL. Special characters in the password (@ : / # ?) must be URL-encoded."] };
  }
  const host = u.hostname;
  const port = u.port || "5432";
  const user = decodeURIComponent(u.username);
  const sslmode = u.searchParams.get("sslmode");
  const libpqCompat = u.searchParams.get("uselibpqcompat") === "true";
  const warnings: string[] = [];

  if (["localhost", "127.0.0.1", "::1"].includes(host)) {
    warnings.push("DATABASE_URL points at localhost, which does not exist on a hosting platform.");
  }
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    warnings.push("This is Supabase's direct connection host, which is IPv6-only and unreachable from Vercel. Use the Transaction pooler URL (port 6543).");
  }
  if (host.endsWith(".pooler.supabase.com")) {
    if (!/^postgres\.[a-z0-9]+$/.test(user)) {
      warnings.push(`The Supabase pooler needs the user "postgres.<project-ref>", not "${user}".`);
    }
    if (sslmode === "require" && !libpqCompat) {
      warnings.push("With sslmode=require, node-postgres verifies the certificate and rejects Supabase's CA. Add &uselibpqcompat=true.");
    }
  }
  if (!u.password) warnings.push("DATABASE_URL has no password.");
  if (/\[?YOUR-PASSWORD\]?/i.test(decodeURIComponent(u.password))) {
    warnings.push("The [YOUR-PASSWORD] placeholder was not replaced with the real password.");
  }

  return { configured: true, host, port, user, database: u.pathname.replace(/^\//, "") || "postgres", sslmode, libpqCompat, hasPassword: !!u.password, warnings };
}

export type DbErrorKind =
  | "not_configured"
  | "host_not_found"
  | "connection_refused"
  | "network_unreachable"
  | "timeout"
  | "tls_certificate"
  | "authentication_failed"
  | "pooler_tenant_not_found"
  | "database_not_found"
  | "schema_missing"
  | "unknown";

const HINTS: Record<DbErrorKind, string> = {
  not_configured: "DATABASE_URL is not set for this environment. Add it, then redeploy.",
  host_not_found: "The database host name does not resolve. Copy the host exactly from the provider's connection settings.",
  connection_refused: "Nothing is listening at that host and port. Check the port (Supabase pooler: 6543) and that the URL is not localhost.",
  network_unreachable: "The host is not reachable from this server. Supabase's direct host is IPv6-only: use the Transaction pooler URL.",
  timeout: "The connection timed out. Check the host and port, and that the database project is not paused.",
  tls_certificate: "TLS certificate verification failed. For Supabase, add &uselibpqcompat=true after sslmode=require.",
  authentication_failed: "The database rejected the password. Reset it in the provider's dashboard and update DATABASE_URL (URL-encode special characters).",
  pooler_tenant_not_found: "The pooler does not know this user. On Supabase the user must be postgres.<project-ref>.",
  database_not_found: "The database name in DATABASE_URL does not exist. For Supabase it is \"postgres\".",
  schema_missing: "Connected, but the tables are missing. Run the migrations (npm run db:migrate) against this database.",
  unknown: "Unrecognised database error; see the message.",
};

function errorChain(e: unknown): Array<{ code?: string; message: string }> {
  const out: Array<{ code?: string; message: string }> = [];
  let cur: unknown = e;
  for (let i = 0; cur && i < 6; i++) {
    const err = cur as { code?: unknown; message?: unknown; cause?: unknown };
    out.push({ code: typeof err.code === "string" ? err.code : undefined, message: String(err.message ?? cur) });
    cur = err.cause;
  }
  return out;
}

/** Map a (possibly wrapped) driver error to a cause and a fix. Never includes the URL. */
export function classifyDbError(e: unknown): { kind: DbErrorKind; code: string | null; message: string; hint: string } {
  const chain = errorChain(e);
  const codes = chain.map((c) => c.code).filter(Boolean) as string[];
  const text = chain.map((c) => c.message).join(" | ");
  const root = chain[chain.length - 1];
  const has = (...xs: string[]) => xs.some((x) => codes.includes(x));

  let kind: DbErrorKind = "unknown";
  if (/DATABASE_URL is not configured/.test(text)) kind = "not_configured";
  else if (has("ENOTFOUND", "EAI_AGAIN")) kind = "host_not_found";
  else if (has("ECONNREFUSED")) kind = "connection_refused";
  else if (has("ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL")) kind = "network_unreachable";
  else if (has("ETIMEDOUT") || /timeout/i.test(text)) kind = "timeout";
  else if (has("SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE") || /certificate/i.test(text)) kind = "tls_certificate";
  else if (has("28P01", "28000") || /password authentication failed/i.test(text)) kind = "authentication_failed";
  else if (/tenant or user not found/i.test(text)) kind = "pooler_tenant_not_found";
  else if (has("3D000")) kind = "database_not_found";
  else if (has("42P01")) kind = "schema_missing";

  // Strip any connection string a driver might echo back.
  const message = root.message.replace(/postgres(ql)?:\/\/\S+/gi, "postgres://***");
  return { kind, code: codes[codes.length - 1] ?? null, message, hint: HINTS[kind] };
}

export type DbHealth =
  | { ok: true; latencyMs: number; migrationsApplied: number; users: number; aiEmployees: number; warnings: string[] }
  | { ok: false; latencyMs: number; error: ReturnType<typeof classifyDbError> };

/** Round-trip the database and confirm the schema and seed are in place. */
export async function checkDatabase(getDb: () => DB): Promise<DbHealth> {
  const started = Date.now();
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    // DB is driver-agnostic, so execute() is untyped; both node-postgres and PGlite return { rows }.
    const first = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows[0];
    // A missing table raises 42P01, which classifyDbError reports as "schema_missing".
    const m = await first<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const c = await first<{ users: number; ai_employees: number }>(
      sql`select (select count(*)::int from users) as users, (select count(*)::int from ai_employees) as ai_employees`,
    );
    const warnings: string[] = [];
    if (m.n === 0) warnings.push("No migrations are recorded; run npm run db:migrate.");
    if (c.users === 0) warnings.push("No users exist, so nobody can sign in. Run npm run db:seed.");
    if (c.ai_employees === 0) warnings.push("No AI employees exist. Run npm run db:seed.");
    return { ok: true, latencyMs: Date.now() - started, migrationsApplied: m.n, users: c.users, aiEmployees: c.ai_employees, warnings };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: classifyDbError(e) };
  }
}
