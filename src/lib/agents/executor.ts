import { eq } from "drizzle-orm";
import { aiEmployees } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { ModelRefusalError, ProviderNotConfiguredError } from "@/lib/ai/router";
import { logActivity, type Actor } from "@/lib/domain/activity";
import { getEmployee } from "@/lib/domain/employees";
import { blockTask, completeTask, failTask, markWaitingApproval, setTaskProgress, type Task } from "@/lib/domain/tasks";
import { tasks } from "@/lib/db/schema";
import { getSkill } from "./registry";
import { NonRetryableError, type SkillResult } from "./types";

/**
 * Execute one claimed task as its assigned AI employee.
 *
 * The employee's office status/location is updated from REAL execution state:
 *  start → skill-defined status + location; waiting_approval → waiting area;
 *  completed/blocked → back to desk, idle; error → error at desk.
 */
export async function executeTask(db: DB, task: Task): Promise<SkillResult | { status: "failed"; error: string; retry: boolean }> {
  const employee = await getEmployee(db, task.assigneeEmployeeId);
  const actor: Actor = { type: "agent", id: employee.id };
  const skill = getSkill(task.type);

  const setEmployee = (v: Partial<typeof aiEmployees.$inferInsert>) =>
    db.update(aiEmployees).set({ ...v, updatedAt: new Date(), lastActiveAt: new Date() }).where(eq(aiEmployees.id, employee.id));

  if (!skill) {
    await blockTask(db, task.id, `Skill '${task.type}' is not implemented yet.`);
    return { status: "blocked", reason: `Skill '${task.type}' is not implemented yet.` };
  }
  if (!employee.skills.includes(task.type)) {
    const error = `${employee.name} (${employee.title}) is not authorised to perform '${task.type}'.`;
    await db.update(tasks).set({ status: "failed", error, lockedBy: null, lockedAt: null, completedAt: new Date() }).where(eq(tasks.id, task.id));
    await logActivity(db, actor, "task.failed", error, { entityType: "task", entityId: task.id });
    return { status: "failed", error, retry: false };
  }

  await setEmployee({ status: skill.office.status, location: skill.office.location, currentTaskId: task.id, statusDetail: task.title });
  await logActivity(db, actor, "task.started", `${employee.name} started: ${task.title}`, {
    entityType: "task",
    entityId: task.id,
    detail: { type: task.type, location: skill.office.location, status: skill.office.status },
  });

  try {
    const result = await skill.run({
      db,
      task,
      employee,
      actor,
      progress: async (pct, detail) => {
        await setTaskProgress(db, task.id, pct);
        if (detail) await setEmployee({ statusDetail: `${task.title} — ${detail}` });
      },
    });
    if (result.status === "completed") {
      await completeTask(db, task.id, { summary: result.summary, ...(result.output ?? {}) });
      await setEmployee({ status: "idle", location: "desk", currentTaskId: null, statusDetail: null });
      await logActivity(db, actor, "task.completed", `${employee.name}: ${result.summary}`, { entityType: "task", entityId: task.id });
    } else if (result.status === "blocked") {
      await blockTask(db, task.id, result.reason, result.output);
      await setEmployee({ status: "idle", location: "desk", currentTaskId: null, statusDetail: null });
      await logActivity(db, actor, "task.blocked", `${employee.name} is blocked: ${result.reason}`, { entityType: "task", entityId: task.id });
    } else {
      await markWaitingApproval(db, task.id, { summary: result.summary, approvalId: result.approvalId, ...(result.output ?? {}) });
      await setEmployee({ status: "waiting_approval", location: "waiting_area", currentTaskId: null, statusDetail: result.summary });
      await logActivity(db, actor, "task.waiting_approval", `${employee.name}: ${result.summary}`, { entityType: "task", entityId: task.id });
    }
    return result;
  } catch (e) {
    const err = e as Error;
    if (err instanceof ProviderNotConfiguredError) {
      const reason = `${err.message} This task needs an AI model and will resume once the key is configured.`;
      await blockTask(db, task.id, reason);
      await setEmployee({ status: "idle", location: "desk", currentTaskId: null, statusDetail: null });
      await logActivity(db, actor, "task.blocked", `${employee.name} is blocked: ${err.message}`, { entityType: "task", entityId: task.id });
      return { status: "blocked", reason };
    }
    const nonRetryable = err instanceof NonRetryableError || err instanceof ModelRefusalError || err.name === "TransitionError" || err.name === "AssignmentError";
    let outcome: "retrying" | "failed";
    if (nonRetryable) {
      await db.update(tasks).set({ status: "failed", error: err.message, lockedBy: null, lockedAt: null, completedAt: new Date() }).where(eq(tasks.id, task.id));
      outcome = "failed";
    } else {
      outcome = await failTask(db, task, err.message);
    }
    await setEmployee({ status: "error", location: "desk", currentTaskId: null, statusDetail: `${task.title}: ${err.message}`.slice(0, 500) });
    await logActivity(db, actor, outcome === "failed" ? "task.failed" : "task.retry_scheduled", `${employee.name}: ${task.title} — ${err.message}`, {
      entityType: "task",
      entityId: task.id,
      detail: { attempts: task.attempts, maxAttempts: task.maxAttempts },
    });
    return { status: "failed", error: err.message, retry: outcome === "retrying" };
  }
}
