/**
 * Long-running background worker: executes the AI employees' task queue and the operating
 * schedule continuously, independent of whether anyone has the dashboard open.
 *   npm run worker
 * Alternatively, call POST /api/cron/tick from Vercel Cron / n8n every minute.
 */
import { createNodeDb } from "../src/lib/db/node";
import { tick } from "../src/lib/agents/worker";

const { db, pool } = createNodeDb();
const workerId = `worker-${process.pid}-${Date.now().toString(36)}`;
const intervalMs = Number(process.env.WORKER_POLL_MS ?? 5000);
let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));
console.log(`[${workerId}] started (poll ${intervalMs} ms)`);
while (!stopping) {
  try {
    const r = await tick(db, { workerId, maxTasks: 10, timeBudgetMs: 60_000 });
    if (r.executed.length || r.scheduled.length || r.recovered)
      console.log(
        `[${new Date().toISOString()}] scheduled=${r.scheduled.join(",") || "-"} executed=${r.executed.map((e) => `${e.type}:${e.status}`).join(", ") || "-"} recovered=${r.recovered}`,
      );
  } catch (e) {
    console.error("tick failed:", (e as Error).message);
  }
  await new Promise((res) => setTimeout(res, intervalMs));
}
await pool.end();
console.log("worker stopped");
