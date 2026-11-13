import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { aiEmployees, departments, messages, reports, tasks } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { logActivity } from "./activity";
import { getEmployee } from "./employees";
import { sendMessage } from "./messaging";
import { createTask, type Task } from "./tasks";

/**
 * Direct assignments: a person chats with one AI employee, gives them a task, answers their
 * questions and receives a report when they finish. Everything is stored as real messages,
 * tasks and reports; nothing in the conversation is generated outside the task run.
 */
export const ASSIGNMENT_TASK = "assignment.work";
/** An employee asks at most this many questions per assignment before it must deliver. */
export const MAX_QUESTIONS = 4;

export interface QA {
  question: string;
  answer: string;
}
export interface AssignmentInput {
  instruction: string;
  requestedByUserId: string;
  qa: QA[];
}
export interface AwaitingOutput {
  awaitingUser: true;
  question: string;
}

export const isAwaitingUser = (t: Pick<Task, "status" | "output">) =>
  t.status === "blocked" && (t.output as Partial<AwaitingOutput> | null)?.awaitingUser === true;

/** The assignment (if any) where this employee is waiting for this person's answer. */
export async function pendingQuestion(db: DB, employeeId: string, userId: string): Promise<Task | null> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.type, ASSIGNMENT_TASK),
        eq(tasks.assigneeEmployeeId, employeeId),
        eq(tasks.status, "blocked"),
        sql`${tasks.input}->>'requestedByUserId' = ${userId}`,
        sql`${tasks.output}->>'awaitingUser' = 'true'`,
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

const titleFrom = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
};

/** Give an employee a new task. */
export async function assignTask(db: DB, args: { userId: string; employeeId: string; instruction: string }) {
  const instruction = args.instruction.trim();
  if (!instruction) throw new Error("Write what you want them to do.");
  const employee = await getEmployee(db, args.employeeId);
  if (!employee.active) throw new Error(`${employee.name} is not active.`);
  const input: AssignmentInput = { instruction, requestedByUserId: args.userId, qa: [] };
  const { task } = await createTask(db, {
    type: ASSIGNMENT_TASK,
    title: titleFrom(instruction),
    description: instruction,
    assigneeEmployeeId: employee.id,
    createdBy: { type: "user", id: args.userId },
    priority: 8,
    input: input as unknown as Record<string, unknown>,
    maxAttempts: 2,
  });
  await sendMessage(db, {
    fromUserId: args.userId,
    toEmployeeId: employee.id,
    kind: "task_assignment",
    subject: task.title,
    body: instruction,
    taskId: task.id,
    threadId: task.id,
  });
  return task;
}

/** Answer the employee's open question; the assignment goes back into the queue. */
export async function answerQuestion(db: DB, args: { userId: string; taskId: string; answer: string }) {
  const answer = args.answer.trim();
  if (!answer) throw new Error("Write your answer.");
  const [task] = await db.select().from(tasks).where(eq(tasks.id, args.taskId));
  if (!task || task.type !== ASSIGNMENT_TASK) throw new Error("Assignment not found.");
  if (!isAwaitingUser(task)) throw new Error("This assignment is not waiting for an answer.");
  const input = task.input as unknown as AssignmentInput;
  if (input.requestedByUserId !== args.userId) throw new Error("Only the person who gave this task can answer it.");
  const question = (task.output as unknown as AwaitingOutput).question;
  const next: AssignmentInput = { ...input, qa: [...(input.qa ?? []), { question, answer }] };
  await sendMessage(db, {
    fromUserId: args.userId,
    toEmployeeId: task.assigneeEmployeeId,
    kind: "message",
    body: answer,
    taskId: task.id,
    threadId: task.id,
  });
  await db
    .update(tasks)
    .set({ input: next as unknown as Record<string, unknown>, status: "queued", blockedReason: null, output: null, runAfter: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "blocked")));
  await logActivity(db, { type: "user", id: args.userId }, "assignment.answered", `Answered a question on: ${task.title}`, { entityType: "task", entityId: task.id });
  return task;
}

/**
 * One chat box per employee: if they are waiting for this person's answer, the message is the
 * answer; otherwise it is a new task.
 */
export async function sendToEmployee(db: DB, args: { userId: string; employeeId: string; text: string }) {
  const open = await pendingQuestion(db, args.employeeId, args.userId);
  if (open) {
    await answerQuestion(db, { userId: args.userId, taskId: open.id, answer: args.text });
    return { kind: "answer" as const, taskId: open.id };
  }
  const task = await assignTask(db, { userId: args.userId, employeeId: args.employeeId, instruction: args.text });
  return { kind: "assignment" as const, taskId: task.id };
}

/** The full conversation between one person and one employee, with the live state of each task. */
export async function getConversation(db: DB, userId: string, employeeId: string) {
  const msgs = await db
    .select()
    .from(messages)
    .where(
      or(
        and(eq(messages.fromUserId, userId), eq(messages.toEmployeeId, employeeId)),
        and(eq(messages.fromEmployeeId, employeeId), eq(messages.toUserId, userId)),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(300);
  const taskIds = [...new Set(msgs.map((m) => m.taskId).filter(Boolean) as string[])];
  const taskRows = taskIds.length
    ? await db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status, progress: tasks.progress, blockedReason: tasks.blockedReason, error: tasks.error, output: tasks.output, updatedAt: tasks.updatedAt })
        .from(tasks)
        .where(inArray(tasks.id, taskIds))
    : [];
  const reportIds = msgs.filter((m) => m.relatedType === "report" && m.relatedId).map((m) => m.relatedId!) as string[];
  const reportRows = reportIds.length ? await db.select().from(reports).where(inArray(reports.id, reportIds)) : [];
  return {
    messages: msgs.map((m) => ({
      id: m.id,
      from: m.fromUserId ? ("user" as const) : ("employee" as const),
      kind: m.kind,
      subject: m.subject,
      body: m.body,
      taskId: m.taskId,
      reportId: m.relatedType === "report" ? m.relatedId : null,
      at: m.createdAt,
      readAt: m.readAt,
    })),
    tasks: taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      progress: t.progress,
      awaitingUser: isAwaitingUser(t),
      blockedReason: isAwaitingUser(t) ? null : t.blockedReason,
      error: t.error,
      updatedAt: t.updatedAt,
    })),
    reports: reportRows.map((r) => ({ id: r.id, title: r.title, data: r.data, createdAt: r.createdAt })),
  };
}

/** Mark everything this employee sent this person as read. */
export async function markConversationRead(db: DB, userId: string, employeeId: string) {
  await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(and(eq(messages.fromEmployeeId, employeeId), eq(messages.toUserId, userId), isNull(messages.readAt)));
}

/** Everyone on the team, with what they are doing for this person right now. */
export async function teamOverview(db: DB, userId: string) {
  const [emps, depts, unread, last, active] = await Promise.all([
    db.select().from(aiEmployees).where(eq(aiEmployees.active, true)).orderBy(aiEmployees.code),
    db.select().from(departments),
    db
      .select({ employeeId: messages.fromEmployeeId, n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.toUserId, userId), isNull(messages.readAt)))
      .groupBy(messages.fromEmployeeId),
    db.execute(sql`
      select distinct on (e) e as employee_id, body, kind, created_at, from_user
      from (
        select coalesce(${messages.toEmployeeId}, ${messages.fromEmployeeId}) as e, ${messages.body} as body, ${messages.kind} as kind,
               ${messages.createdAt} as created_at, (${messages.fromUserId} is not null) as from_user
        from ${messages}
        where ${messages.fromUserId} = ${userId} or ${messages.toUserId} = ${userId}
      ) m
      order by e, created_at desc`),
    db
      .select({ employeeId: tasks.assigneeEmployeeId, status: tasks.status, output: tasks.output, title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.type, ASSIGNMENT_TASK),
          inArray(tasks.status, ["queued", "running", "blocked", "waiting_approval"]),
          sql`${tasks.input}->>'requestedByUserId' = ${userId}`,
        ),
      ),
  ]);
  const lastRows = (last as unknown as { rows: { employee_id: string; body: string; kind: string; created_at: string; from_user: boolean }[] }).rows;
  const deptById = new Map(depts.map((d) => [d.id, d]));
  return emps.map((e) => {
    const mine = active.filter((t) => t.employeeId === e.id);
    const l = lastRows.find((r) => r.employee_id === e.id);
    return {
      id: e.id,
      code: e.code,
      name: e.name,
      title: e.title,
      color: e.avatarColor,
      department: deptById.get(e.departmentId)?.name ?? "",
      departmentKey: deptById.get(e.departmentId)?.key ?? "",
      status: e.status,
      statusDetail: e.statusDetail,
      responsibilities: (e.responsibilities as string[]) ?? [],
      unread: unread.find((u) => u.employeeId === e.id)?.n ?? 0,
      awaitingYou: mine.some((t) => isAwaitingUser(t)),
      openAssignments: mine.length,
      lastMessage: l ? { body: l.body, kind: l.kind, at: l.created_at, fromYou: l.from_user } : null,
    };
  });
}

/** Unread messages from the team to this person (for the navigation badge). */
export async function unreadFromTeam(db: DB, userId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.toUserId, userId), isNull(messages.readAt)));
  return r?.n ?? 0;
}
