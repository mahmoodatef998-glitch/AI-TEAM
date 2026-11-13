import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { reports, tasks, users } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { runAssignment, type AssignmentDecision, type Thinker } from "@/lib/agents/skills/assignment";
import { executeTask } from "@/lib/agents/executor";
import { claimNextTask } from "@/lib/domain/tasks";
import {
  answerQuestion,
  ASSIGNMENT_TASK,
  getConversation,
  markConversationRead,
  MAX_QUESTIONS,
  pendingQuestion,
  sendToEmployee,
  teamOverview,
  unreadFromTeam,
} from "@/lib/domain/assignments";
import { getEmployee, getEmployeeByRole } from "@/lib/domain/employees";
import { createTestDb } from "./helpers";

async function setup() {
  const db = await createTestDb();
  const [u] = await db.insert(users).values({ email: "boss@example.com", name: "Mahmoud", passwordHash: "x", role: "admin" }).returning();
  const nadia = await getEmployeeByRole(db, "cgo");
  return { db, user: u, nadia };
}

/** Claim the queued assignment and run one step of it with a scripted "model". */
async function step(db: DB, decide: AssignmentDecision | ((p: { system: string; prompt: string }) => AssignmentDecision)) {
  const task = (await claimNextTask(db, "test"))!;
  expect(task.type).toBe(ASSIGNMENT_TASK);
  const employee = await getEmployee(db, task.assigneeEmployeeId);
  let seen: { system: string; prompt: string } | null = null;
  const think: Thinker = async (_ctx, p) => {
    seen = p;
    return typeof decide === "function" ? decide(p) : decide;
  };
  const result = await runAssignment({ db, task, employee, actor: { type: "agent", id: employee.id }, progress: async () => {} }, think);
  return { task, result, prompt: seen! };
}

const ask = (question: string): AssignmentDecision => ({ status: "needs_input", question, report: null });
const done: AssignmentDecision = {
  status: "done",
  question: null,
  report: { title: "Q4 focus plan", summary: "Three priorities for Q4.", body: "## Plan\n1. ...", nextSteps: ["Set the target"], assumptions: ["No target set yet"] },
};

describe("direct assignments from the team chat", () => {
  it("a message to an idle employee becomes a task assigned to them", async () => {
    const { db, user, nadia } = await setup();
    const r = await sendToEmployee(db, { userId: user.id, employeeId: nadia.id, text: "اعملي خطة للربع الرابع" });
    expect(r.kind).toBe("assignment");
    const [t] = await db.select().from(tasks).where(eq(tasks.id, r.taskId));
    expect(t).toMatchObject({ type: ASSIGNMENT_TASK, status: "queued", assigneeEmployeeId: nadia.id });
    const c = await getConversation(db, user.id, nadia.id);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]).toMatchObject({ from: "user", kind: "task_assignment", taskId: r.taskId });
  });

  it("asks a question, takes the answer, then delivers a report", async () => {
    const { db, user, nadia } = await setup();
    const { taskId } = await sendToEmployee(db, { userId: user.id, employeeId: nadia.id, text: "Plan Q4 for the sales team" });

    const first = await step(db, ask("What is the Q4 revenue target?"));
    expect(first.result).toMatchObject({ status: "blocked", output: { awaitingUser: true, question: "What is the Q4 revenue target?" } });
    expect(first.prompt.system).toContain("Nadia");
    expect(first.prompt.prompt).toContain("Plan Q4 for the sales team");

    // The executor would persist the blocked state; do the same here.
    await db.update(tasks).set({ status: "blocked", output: first.result.output, blockedReason: "waiting" }).where(eq(tasks.id, taskId));
    expect((await pendingQuestion(db, nadia.id, user.id))?.id).toBe(taskId);
    expect(await unreadFromTeam(db, user.id)).toBe(1);
    const overview = await teamOverview(db, user.id);
    expect(overview.find((e) => e.id === nadia.id)).toMatchObject({ awaitingYou: true, unread: 1 });

    // The next message to Nadia is treated as the answer, not a new task.
    const r = await sendToEmployee(db, { userId: user.id, employeeId: nadia.id, text: "AED 2M" });
    expect(r).toEqual({ kind: "answer", taskId });
    const second = await step(db, (p) => {
      expect(p.prompt).toContain("What is the Q4 revenue target?");
      expect(p.prompt).toContain("AED 2M");
      return done;
    });
    expect(second.result).toMatchObject({ status: "completed", summary: "Three priorities for Q4." });

    const [rep] = await db.select().from(reports).where(eq(reports.taskId, taskId));
    expect(rep).toMatchObject({ kind: "assignment_report", title: "Q4 focus plan", authorEmployeeId: nadia.id });
    const c = await getConversation(db, user.id, nadia.id);
    expect(c.messages.map((m) => [m.from, m.kind])).toEqual([
      ["user", "task_assignment"],
      ["employee", "information_request"],
      ["user", "message"],
      ["employee", "report"],
    ]);
    expect(c.messages[3].reportId).toBe(rep.id);
    expect(c.reports[0].id).toBe(rep.id);

    await markConversationRead(db, user.id, nadia.id);
    expect(await unreadFromTeam(db, user.id)).toBe(0);
  });

  it("stops asking after the question limit and must deliver", async () => {
    const { db, user, nadia } = await setup();
    const { taskId } = await sendToEmployee(db, { userId: user.id, employeeId: nadia.id, text: "Plan Q4" });
    const qa = Array.from({ length: MAX_QUESTIONS }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
    await db.update(tasks).set({ input: { instruction: "Plan Q4", requestedByUserId: user.id, qa } }).where(eq(tasks.id, taskId));
    const s = await step(db, (p) => {
      expect(p.system).toMatch(/MUST now set status=done/);
      return { ...done, status: "needs_input", question: "one more?" };
    });
    expect(s.result.status).toBe("completed");
  });

  it("only the person who gave the task can answer it", async () => {
    const { db, user, nadia } = await setup();
    const [other] = await db.insert(users).values({ email: "x@example.com", name: "Other", passwordHash: "x", role: "admin" }).returning();
    const { taskId } = await sendToEmployee(db, { userId: user.id, employeeId: nadia.id, text: "Plan Q4" });
    const s = await step(db, ask("Target?"));
    await db.update(tasks).set({ status: "blocked", output: s.result.output }).where(eq(tasks.id, taskId));
    await expect(answerQuestion(db, { userId: other.id, taskId, answer: "1M" })).rejects.toThrow(/Only the person/);
    // The other person's message to Nadia starts a separate task instead.
    expect((await sendToEmployee(db, { userId: other.id, employeeId: nadia.id, text: "Something else" })).kind).toBe("assignment");
  });

  it("any employee may take a chat assignment, and it blocks cleanly without an AI key", async () => {
    const { db, user } = await setup();
    const faris = await getEmployeeByRole(db, "technical_sales_assistant");
    expect(faris.skills).not.toContain(ASSIGNMENT_TASK);
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { taskId } = await sendToEmployee(db, { userId: user.id, employeeId: faris.id, text: "Draft an RFQ checklist" });
      const task = (await claimNextTask(db, "test"))!;
      const r = await executeTask(db, task);
      expect(r.status).toBe("blocked");
      const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(t.blockedReason).toMatch(/ANTHROPIC_API_KEY/);
      const c = await getConversation(db, user.id, faris.id);
      expect(c.tasks[0]).toMatchObject({ status: "blocked", awaitingUser: false });
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
