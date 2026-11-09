import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { aiEmployees, tasks } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { logActivity, type Actor } from "./activity";

export type Task = typeof tasks.$inferSelect;

export interface CreateTaskInput {
  type: string;
  title: string;
  description?: string;
  assigneeEmployeeId: string;
  createdBy: Actor;
  parentTaskId?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  priority?: number;
  input?: Record<string, unknown>;
  runAfter?: Date;
  dedupeKey?: string | null;
  maxAttempts?: number;
}

/**
 * Create a task. If `dedupeKey` is set and an active task with the same key exists,
 * the existing task is returned instead (idempotent enqueue).
 */
export async function createTask(db: DB, t: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
  if (t.dedupeKey) {
    const existing = await findActiveByDedupeKey(db, t.dedupeKey);
    if (existing) return { task: existing, created: false };
  }
  const rows = await db
    .insert(tasks)
    .values({
      type: t.type,
      title: t.title,
      description: t.description ?? null,
      assigneeEmployeeId: t.assigneeEmployeeId,
      createdByType: t.createdBy.type,
      createdById: t.createdBy.id ?? null,
      parentTaskId: t.parentTaskId ?? null,
      relatedType: t.relatedType ?? null,
      relatedId: t.relatedId ?? null,
      priority: t.priority ?? 5,
      input: t.input ?? {},
      runAfter: t.runAfter ?? new Date(),
      dedupeKey: t.dedupeKey ?? null,
      maxAttempts: t.maxAttempts ?? 3,
    })
    .onConflictDoNothing()
    .returning();
  if (rows.length === 0) {
    // Lost a race with a concurrent enqueue of the same dedupe key.
    const existing = t.dedupeKey ? await findActiveByDedupeKey(db, t.dedupeKey) : undefined;
    if (!existing) throw new Error(`Failed to create task ${t.type}`);
    return { task: existing, created: false };
  }
  const task = rows[0];
  await logActivity(db, t.createdBy, "task.created", `Task queued: ${t.title}`, {
    entityType: "task",
    entityId: task.id,
    detail: { type: t.type, assignee: t.assigneeEmployeeId },
  });
  return { task, created: true };
}

async function findActiveByDedupeKey(db: DB, key: string) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.dedupeKey, key), inArray(tasks.status, ["queued", "running", "waiting_approval", "blocked"])))
    .limit(1);
  return row;
}

/**
 * Atomically claim the next runnable task (FOR UPDATE SKIP LOCKED) so that multiple workers
 * never execute the same task. An employee works on one task at a time: tasks whose assignee
 * already has a running task are skipped.
 */
export async function claimNextTask(db: DB, workerId: string): Promise<Task | null> {
  const result = await db.execute(sql`
    update tasks set status = 'running', locked_by = ${workerId}, locked_at = now(),
      started_at = coalesce(started_at, now()), attempts = attempts + 1, updated_at = now()
    where id = (
      select t.id from tasks t
      where t.status = 'queued' and t.run_after <= now()
        and not exists (
          select 1 from tasks r where r.assignee_employee_id = t.assignee_employee_id and r.status = 'running'
        )
      order by t.priority desc, t.run_after asc, t.created_at asc
      for update skip locked
      limit 1
    )
    returning id
  `);
  const id = (result as unknown as { rows: { id: string }[] }).rows[0]?.id;
  if (!id) return null;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  return task ?? null;
}

export async function setTaskProgress(db: DB, taskId: string, progress: number) {
  await db
    .update(tasks)
    .set({ progress: Math.max(0, Math.min(100, Math.round(progress))), updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function completeTask(db: DB, taskId: string, output: Record<string, unknown>) {
  await db
    .update(tasks)
    .set({ status: "completed", output, progress: 100, completedAt: new Date(), lockedBy: null, lockedAt: null, error: null, blockedReason: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

/** The task cannot proceed until a human provides an integration, credential or data. */
export async function blockTask(db: DB, taskId: string, reason: string, output?: Record<string, unknown>) {
  await db
    .update(tasks)
    .set({ status: "blocked", blockedReason: reason, output: output ?? null, lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

export async function markWaitingApproval(db: DB, taskId: string, output: Record<string, unknown>) {
  await db
    .update(tasks)
    .set({ status: "waiting_approval", output, progress: 90, lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

/** Exponential backoff retry: 1m, 4m, 16m … until maxAttempts, then failed. */
export async function failTask(db: DB, task: Task, error: string): Promise<"retrying" | "failed"> {
  const exhausted = task.attempts >= task.maxAttempts;
  if (exhausted) {
    await db
      .update(tasks)
      .set({ status: "failed", error, lockedBy: null, lockedAt: null, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return "failed";
  }
  const delayMs = 60_000 * Math.pow(4, Math.max(0, task.attempts - 1));
  await db
    .update(tasks)
    .set({ status: "queued", error, lockedBy: null, lockedAt: null, runAfter: new Date(Date.now() + delayMs), updatedAt: new Date() })
    .where(eq(tasks.id, task.id));
  return "retrying";
}

/** Re-queue a blocked task (e.g. after the missing integration was configured). */
export async function requeueTask(db: DB, taskId: string, actor: Actor) {
  await db
    .update(tasks)
    .set({ status: "queued", blockedReason: null, error: null, runAfter: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ["blocked", "failed"])));
  await logActivity(db, actor, "task.requeued", "Task re-queued", { entityType: "task", entityId: taskId });
}

export async function cancelTask(db: DB, taskId: string, actor: Actor) {
  await db
    .update(tasks)
    .set({ status: "cancelled", lockedBy: null, lockedAt: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ["queued", "blocked", "failed", "waiting_approval"])));
  await logActivity(db, actor, "task.cancelled", "Task cancelled", { entityType: "task", entityId: taskId });
}

/** Recover tasks whose worker died mid-execution (lock older than `staleMs`). */
export async function recoverStaleTasks(db: DB, staleMs = 10 * 60_000) {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await db
    .update(tasks)
    .set({ status: "queued", lockedBy: null, lockedAt: null, error: "Recovered from stale lock", updatedAt: new Date() })
    .where(and(eq(tasks.status, "running"), lt(tasks.lockedAt, cutoff)))
    .returning({ id: tasks.id, assignee: tasks.assigneeEmployeeId });
  for (const s of stale) {
    await db
      .update(aiEmployees)
      .set({ status: "idle", location: "desk", currentTaskId: null, statusDetail: null })
      .where(and(eq(aiEmployees.id, s.assignee), eq(aiEmployees.currentTaskId, s.id)));
  }
  return stale.length;
}
