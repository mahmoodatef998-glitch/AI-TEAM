import type { DB } from "@/lib/db/types";
import { claimNextTask, recoverStaleTasks } from "@/lib/domain/tasks";
import { executeTask } from "./executor";
import { runScheduler } from "./scheduler";

export interface TickResult {
  recovered: number;
  scheduled: string[];
  executed: { taskId: string; type: string; status: string }[];
}

/**
 * One unit of background work: recover stale locks, fire due schedules, then execute queued
 * tasks until `maxTasks` or `timeBudgetMs` is reached. Safe to call concurrently from several
 * workers (tasks are claimed with FOR UPDATE SKIP LOCKED).
 */
export async function tick(db: DB, opts: { workerId?: string; maxTasks?: number; timeBudgetMs?: number } = {}): Promise<TickResult> {
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 50_000);
  const recovered = await recoverStaleTasks(db);
  const scheduled = await runScheduler(db);
  const executed: TickResult["executed"] = [];
  while (executed.length < (opts.maxTasks ?? 25) && Date.now() < deadline) {
    const task = await claimNextTask(db, workerId);
    if (!task) break;
    const r = await executeTask(db, task);
    executed.push({ taskId: task.id, type: task.type, status: r.status });
  }
  return { recovered, scheduled, executed };
}
