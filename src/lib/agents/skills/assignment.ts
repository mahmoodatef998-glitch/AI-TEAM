import { z } from "zod";
import { reports, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateStructured } from "@/lib/ai/router";
import { ASSIGNMENT_TASK, MAX_QUESTIONS, type AssignmentInput } from "@/lib/domain/assignments";
import { getKnowledge, knowledgeAsPrompt } from "@/lib/domain/knowledge";
import { recall, remember } from "@/lib/domain/memory";
import { sendMessage } from "@/lib/domain/messaging";
import type { Skill, SkillContext, SkillResult } from "../types";
import { NonRetryableError } from "../types";

export const AssignmentDecision = z.object({
  status: z.enum(["needs_input", "done"]),
  /** One specific question for the person, when status is needs_input. */
  question: z.string().nullable(),
  /** The deliverable, when status is done. */
  report: z
    .object({
      title: z.string(),
      summary: z.string(),
      body: z.string(),
      nextSteps: z.array(z.string()),
      assumptions: z.array(z.string()),
    })
    .nullable(),
});
export type AssignmentDecision = z.infer<typeof AssignmentDecision>;

export type Thinker = (ctx: SkillContext, prompt: { system: string; prompt: string }) => Promise<AssignmentDecision>;

const defaultThinker: Thinker = (ctx, p) =>
  generateStructured(
    { db: ctx.db, employeeId: ctx.employee.id, taskId: ctx.task.id },
    { profile: "reasoning", system: p.system, prompt: p.prompt, schema: AssignmentDecision, maxTokens: 12000 },
  );

export function buildAssignmentPrompt(ctx: SkillContext, input: AssignmentInput, facts: string, memories: string[], requester: string) {
  const e = ctx.employee;
  const askedOut = (input.qa?.length ?? 0) >= MAX_QUESTIONS;
  const system = [
    `You are ${e.name}, ${e.title} at 4U Power Generation FZC (SAIF Zone, Sharjah, UAE), an AI employee.`,
    `Persona: ${e.persona}`,
    `Job: ${e.jobDescription}`,
    `Responsibilities: ${(e.responsibilities as string[]).join("; ")}`,
    "",
    `${requester} (your manager) gave you the task below in a chat. Work on it and either deliver it or ask ONE question.`,
    "Rules:",
    "- Reply in the same language the task is written in.",
    "- Never invent customers, contacts, prices, stock, specifications, results or market figures. Only state 4U facts that appear in VERIFIED COMPANY FACTS.",
    "- You cannot browse the web, send emails, call anyone or change systems in this task. You deliver written work: plans, drafts, analyses, checklists, recommendations.",
    "- If you are missing information that would change the result, set status=needs_input and ask one short, specific question. Otherwise set status=done.",
    askedOut
      ? `- You have already asked ${input.qa.length} questions. You MUST now set status=done, deliver your best work and list what you assumed.`
      : `- Ask at most ${MAX_QUESTIONS} questions in total; prefer delivering with clearly listed assumptions over asking about minor details.`,
    "- When done: report.title is short; report.summary is 1-3 sentences for the chat; report.body is the full deliverable in Markdown; nextSteps are concrete actions; assumptions lists anything you assumed.",
  ].join("\n");
  const qa = (input.qa ?? []).map((x, i) => `Q${i + 1} (you): ${x.question}\nA${i + 1} (${requester}): ${x.answer}`).join("\n\n");
  const prompt = [
    `TASK FROM ${requester.toUpperCase()}:\n${input.instruction}`,
    qa ? `\nYOUR QUESTIONS AND THE ANSWERS SO FAR:\n${qa}` : "",
    memories.length ? `\nYOUR NOTES FROM EARLIER WORK:\n${memories.map((m) => `- ${m}`).join("\n")}` : "",
    `\n${facts}`,
  ].join("\n");
  return { system, prompt };
}

/** Run one step of an assignment: deliver it or ask the person one question. */
export async function runAssignment(ctx: SkillContext, think: Thinker = defaultThinker): Promise<SkillResult> {
  const { db, task, employee } = ctx;
  const input = task.input as unknown as AssignmentInput;
  if (!input?.instruction || !input.requestedByUserId) throw new NonRetryableError("Assignment is missing its instruction or requester.");
  const [requester] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.requestedByUserId));
  if (!requester) throw new NonRetryableError("The person who gave this assignment no longer exists.");

  await ctx.progress(10, "reading the task");
  const kb = await getKnowledge(db);
  const mem = await recall(db, employee.id, undefined, 10);
  const p = buildAssignmentPrompt(ctx, input, knowledgeAsPrompt(kb), mem.map((m) => m.content), requester.name);
  await ctx.progress(30, "working on it");
  const d = await think(ctx, p);

  const mustFinish = (input.qa?.length ?? 0) >= MAX_QUESTIONS;
  if (d.status === "needs_input" && d.question?.trim() && !mustFinish) {
    const question = d.question.trim();
    await sendMessage(db, {
      fromEmployeeId: employee.id,
      toUserId: requester.id,
      kind: "information_request",
      body: question,
      taskId: task.id,
      threadId: task.id,
    });
    return { status: "blocked", reason: `Waiting for ${requester.name}'s answer: ${question}`, output: { awaitingUser: true, question } };
  }
  if (!d.report) throw new Error("The model returned neither a question nor a report.");

  await ctx.progress(90, "writing the report");
  const r = d.report;
  const [row] = await db
    .insert(reports)
    .values({
      kind: "assignment_report",
      title: r.title,
      data: { instruction: input.instruction, qa: input.qa ?? [], summary: r.summary, body: r.body, nextSteps: r.nextSteps, assumptions: r.assumptions },
      narrative: r.body,
      authorEmployeeId: employee.id,
      taskId: task.id,
    })
    .returning();
  await sendMessage(db, {
    fromEmployeeId: employee.id,
    toUserId: requester.id,
    kind: "report",
    subject: r.title,
    body: r.summary,
    relatedType: "report",
    relatedId: row.id,
    taskId: task.id,
    threadId: task.id,
  });
  await remember(db, { employeeId: employee.id, kind: "assignment", content: `Done for ${requester.name}: ${task.title} — ${r.summary}`.slice(0, 1000), importance: 2, sourceTaskId: task.id });
  return { status: "completed", summary: r.summary, output: { reportId: row.id } };
}

export const assignmentWork: Skill = {
  type: ASSIGNMENT_TASK,
  label: "Work on a task from the chat",
  office: { status: "working", location: "desk" },
  run: (ctx) => runAssignment(ctx),
};
