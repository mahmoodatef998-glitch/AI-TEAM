import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { checkDatabase, classifyDbError, describeDatabaseUrl } from "@/lib/db/health";
import { createTestDb } from "./helpers";

const POOLER = "postgresql://postgres.abcdefghijklmnop:s3cret@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";
const wrapped = (cause: object) => Object.assign(new Error('Failed query: select "id" from "users"'), { cause });

describe("describeDatabaseUrl", () => {
  it("accepts a correct Supabase pooler URL and never returns the password", () => {
    const d = describeDatabaseUrl(`${POOLER}?sslmode=require&uselibpqcompat=true`);
    expect(d).toMatchObject({ configured: true, host: "aws-1-ap-south-1.pooler.supabase.com", port: "6543", user: "postgres.abcdefghijklmnop", hasPassword: true, warnings: [] });
    expect(JSON.stringify(d)).not.toContain("s3cret");
  });

  it("flags the common deployment mistakes", () => {
    expect(describeDatabaseUrl(undefined)).toMatchObject({ configured: false });
    expect(describeDatabaseUrl("not a url").warnings[0]).toMatch(/URL-encoded/);
    expect(describeDatabaseUrl("postgres://postgres:postgres@localhost:5432/x").warnings.join()).toMatch(/localhost/);
    expect(describeDatabaseUrl("postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres").warnings.join()).toMatch(/IPv6-only/);
    expect(describeDatabaseUrl("postgresql://postgres:pw@aws-1-ap-south-1.pooler.supabase.com:6543/postgres").warnings.join()).toMatch(/postgres\.<project-ref>/);
    expect(describeDatabaseUrl(`${POOLER}?sslmode=require`).warnings.join()).toMatch(/uselibpqcompat/);
    expect(describeDatabaseUrl(POOLER.replace("s3cret", "[YOUR-PASSWORD]")).warnings.join()).toMatch(/placeholder/);
  });
});

describe("classifyDbError", () => {
  it.each([
    [new Error("DATABASE_URL is not configured"), "not_configured"],
    [wrapped({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND db.example" }), "host_not_found"],
    [wrapped({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5432" }), "connection_refused"],
    [wrapped({ code: "ENETUNREACH", message: "connect ENETUNREACH 2406:da18::1:5432" }), "network_unreachable"],
    [wrapped({ message: "timeout expired" }), "timeout"],
    [wrapped({ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self-signed certificate in certificate chain" }), "tls_certificate"],
    [wrapped({ code: "28P01", message: 'password authentication failed for user "postgres"' }), "authentication_failed"],
    [wrapped({ code: "XX000", message: "Tenant or user not found" }), "pooler_tenant_not_found"],
    [wrapped({ code: "42P01", message: 'relation "users" does not exist' }), "schema_missing"],
  ])("classifies %#", (err, kind) => {
    expect(classifyDbError(err).kind).toBe(kind);
  });

  it("does not echo connection strings", () => {
    const d = classifyDbError(wrapped({ message: `could not connect to ${POOLER}` }));
    expect(d.message).not.toContain("s3cret");
  });
});

describe("checkDatabase", () => {
  it("reports a migrated and seeded database as healthy, and warns that no user can sign in yet", async () => {
    const db = await createTestDb();
    const h = await checkDatabase(() => db);
    expect(h).toMatchObject({ ok: true, migrationsApplied: 1, users: 0, aiEmployees: 16 });
    expect(h.ok && h.warnings.join()).toMatch(/db:seed/);
  });

  it("reports missing tables as schema_missing", async () => {
    const empty = drizzle(new PGlite(), { schema }) as unknown as DB;
    const h = await checkDatabase(() => empty);
    expect(h.ok).toBe(false);
    expect(!h.ok && h.error.kind).toBe("schema_missing");
  });

  it("reports a missing DATABASE_URL without throwing", async () => {
    const h = await checkDatabase(() => {
      throw new Error("DATABASE_URL is not configured");
    });
    expect(!h.ok && h.error.kind).toBe("not_configured");
  });
});
