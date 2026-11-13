import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { ASSIGNMENT_TASK } from "@/lib/domain/assignments";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { activityLog, aiEmployees, approvals, departments, messages, tasks } from "@/lib/db/schema";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Snapshot for the virtual office. Everything here is read from real system state:
 * employee status/location are written by the agent executor when tasks start, wait for
 * approval, complete or fail; collaboration lines come from real internal messages.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb();
  const waiting = await db
    .select({ id: tasks.assigneeEmployeeId })
    .from(tasks)
    .where(
      and(
        eq(tasks.type, ASSIGNMENT_TASK),
        eq(tasks.status, "blocked"),
        sql`${tasks.output}->>'awaitingUser' = 'true'`,
        sql`${tasks.input}->>'requestedByUserId' = ${user.id}`,
      ),
    );
  const waitingForYou = new Set(waiting.map((w) => w.id));
  const since = new Date(Date.now() - 120_000);
  const [emps, depts, recentMsgs, feed, pending] = await Promise.all([
    db.select().from(aiEmployees).where(eq(aiEmployees.active, true)).orderBy(aiEmployees.code),
    db.select().from(departments),
    db.select({ id: messages.id, from: messages.fromEmployeeId, to: messages.toEmployeeId, kind: messages.kind, subject: messages.subject, at: messages.createdAt }).from(messages).where(gte(messages.createdAt, since)).orderBy(desc(messages.createdAt)).limit(20),
    db.select({ id: activityLog.id, actorType: activityLog.actorType, actorId: activityLog.actorId, summary: activityLog.summary, at: activityLog.createdAt }).from(activityLog).orderBy(desc(activityLog.createdAt)).limit(25),
    db.select({ id: approvals.id }).from(approvals).where(eq(approvals.status, "pending")),
  ]);
  const taskIds = emps.map((e) => e.currentTaskId).filter(Boolean) as string[];
  const current = taskIds.length ? await db.select({ id: tasks.id, title: tasks.title, progress: tasks.progress, type: tasks.type }).from(tasks).where(inArray(tasks.id, taskIds)) : [];
  const deptZone = new Map(depts.map((d) => [d.id, d.officeZone]));
  return NextResponse.json({
    now: new Date().toISOString(),
    pendingApprovals: pending.length,
    employees: emps.map((e) => {
      const t = current.find((c) => c.id === e.currentTaskId);
      return {
        id: e.id, code: e.code, name: e.name, title: e.title, color: e.avatarColor,
        status: e.status, location: e.location, homeZone: deptZone.get(e.departmentId),
        detail: e.statusDetail, task: t ? { title: t.title, progress: t.progress, type: t.type } : null,
        lastActiveAt: e.lastActiveAt,
        awaitingYou: waitingForYou.has(e.id),
      };
    }),
    collaboration: recentMsgs.filter((m) => m.from && m.to).map((m) => ({ id: m.id, from: m.from, to: m.to, kind: m.kind, subject: m.subject, at: m.at })),
    feed: feed.map((f) => ({ ...f, actorName: f.actorType === "agent" ? emps.find((e) => e.id === f.actorId)?.name ?? null : null })),
  });
}
