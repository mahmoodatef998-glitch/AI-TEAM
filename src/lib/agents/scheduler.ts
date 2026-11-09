import { eq } from "drizzle-orm";
import { schedules } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { getEmployeeByRole } from "@/lib/domain/employees";
import { createTask } from "@/lib/domain/tasks";
import { latestSlot } from "./cron";

/**
 * Enqueue tasks for schedules whose slot has arrived since the last run. Idempotent: each slot
 * is enqueued once (dedupe key schedule:<key>:<slot>), so multiple workers / cron callers are safe.
 * Missed slots older than the catch-up window (3h) are skipped rather than replayed in bulk.
 */
export async function runScheduler(db: DB, now = new Date()) {
  const all = await db.select().from(schedules).where(eq(schedules.enabled, true));
  const enqueued: string[] = [];
  for (const s of all) {
    const from = s.lastRunAt ?? new Date(now.getTime() - 3 * 3600_000);
    const slot = latestSlot(s.cron, from, now, s.timezone);
    if (!slot) continue;
    const slotKey = slot.toISOString();
    if (s.lastSlot === slotKey) continue;
    const assignee = await getEmployeeByRole(db, s.assigneeRoleKey);
    const { created } = await createTask(db, {
      type: s.taskType,
      title: s.name,
      assigneeEmployeeId: assignee.id,
      createdBy: { type: "system" },
      priority: 6,
      input: { ...s.input, scheduleKey: s.key, slot: slotKey },
      dedupeKey: `schedule:${s.key}:${slotKey}`,
    });
    await db.update(schedules).set({ lastRunAt: now, lastSlot: slotKey }).where(eq(schedules.id, s.id));
    if (created) enqueued.push(s.key);
  }
  return enqueued;
}
