import { NextResponse } from "next/server";
import { hasBearerSecret } from "@/lib/auth/bearer";
import { getDb } from "@/lib/db";
import { checkDatabase, describeDatabaseUrl } from "@/lib/db/health";

/**
 * Health check.
 *   Public:                                   { status: "ok" | "error" }  (200 / 503, for uptime monitors)
 *   Authorization: Bearer $CRON_SECRET  →  why the database is or is not reachable, without secrets.
 */
export async function GET(req: Request) {
  const health = await checkDatabase(getDb);
  const status = health.ok ? 200 : 503;
  const secret = process.env.CRON_SECRET;
  if (!secret || !hasBearerSecret(req, secret)) {
    return NextResponse.json({ status: health.ok ? "ok" : "error" }, { status, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    {
      status: health.ok ? "ok" : "error",
      database: health,
      databaseUrl: describeDatabaseUrl(process.env.DATABASE_URL),
      env: {
        CRON_SECRET: true,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        XAI_API_KEY: !!process.env.XAI_API_KEY,
        ODOO_URL: !!process.env.ODOO_URL,
      },
      region: process.env.VERCEL_REGION ?? null,
      deployment: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}
