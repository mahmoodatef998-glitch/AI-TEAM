import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { tick } from "@/lib/agents/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Run the scheduler and the AI employees' task queue. Call every minute from Vercel Cron,
 * n8n or any scheduler:  Authorization: Bearer $CRON_SECRET
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await tick(getDb(), { workerId: `cron-${Date.now().toString(36)}`, maxTasks: 20, timeBudgetMs: 240_000 });
  return NextResponse.json(result);
}

export const GET = handle;
export const POST = handle;
