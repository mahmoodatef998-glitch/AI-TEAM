import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, aiEmployees, approvals, interactions, opportunities, schedules, tasks } from "@/lib/db/schema";
import { tick } from "@/lib/agents/worker";
import { cronMatches, latestSlot } from "@/lib/agents/cron";
import { runScheduler } from "@/lib/agents/scheduler";
import { getEmployeeByRole } from "@/lib/domain/employees";
import { intakeLead } from "@/lib/domain/leads";
import { claimNextTask, createTask, failTask, recoverStaleTasks } from "@/lib/domain/tasks";
import { agent, createTestDb, strongLead } from "./helpers";

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("task queue", () => {
  it("dedupes active tasks by key", async () => {
    const db = await createTestDb();
    const e = await getEmployeeByRole(db, "business_analyst");
    const a = await createTask(db, { type: "report.daily_performance", title: "r", assigneeEmployeeId: e.id, createdBy: { type: "system" }, dedupeKey: "k1" });
    const b = await createTask(db, { type: "report.daily_performance", title: "r", assigneeEmployeeId: e.id, createdBy: { type: "system" }, dedupeKey: "k1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
  });

  it("runs one task per employee at a time and respects priority", async () => {
    const db = await createTestDb();
    const e = await getEmployeeByRole(db, "business_analyst");
    const c = await getEmployeeByRole(db, "cgo");
    await createTask(db, { type: "report.daily_performance", title: "low", assigneeEmployeeId: e.id, createdBy: { type: "system" }, priority: 1 });
    await createTask(db, { type: "report.daily_performance", title: "high", assigneeEmployeeId: e.id, createdBy: { type: "system" }, priority: 9 });
    await createTask(db, { type: "kpi.plan", title: "cgo", assigneeEmployeeId: c.id, createdBy: { type: "system" }, priority: 5 });
    const t1 = await claimNextTask(db, "w1");
    expect(t1!.title).toBe("high");
    const t2 = await claimNextTask(db, "w2");
    expect(t2!.title).toBe("cgo"); // analyst is busy, so the CGO's task is next
    expect(await claimNextTask(db, "w3")).toBeNull();
  });

  it("retries with backoff, then fails; recovers stale locks", async () => {
    const db = await createTestDb();
    const e = await getEmployeeByRole(db, "business_analyst");
    await createTask(db, { type: "x", title: "t", assigneeEmployeeId: e.id, createdBy: { type: "system" }, maxAttempts: 2 });
    let t = (await claimNextTask(db, "w"))!;
    expect(await failTask(db, t, "boom")).toBe("retrying");
    const [q] = await db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(q.status).toBe("queued");
    expect(q.runAfter.getTime()).toBeGreaterThan(Date.now());
    await db.update(tasks).set({ runAfter: new Date(0) }).where(eq(tasks.id, t.id));
    t = (await claimNextTask(db, "w"))!;
    expect(await failTask(db, t, "boom")).toBe("failed");

    await createTask(db, { type: "x", title: "stale", assigneeEmployeeId: e.id, createdBy: { type: "system" } });
    const s = (await claimNextTask(db, "dead-worker"))!;
    await db.update(tasks).set({ lockedAt: new Date(Date.now() - 3600_000) }).where(eq(tasks.id, s.id));
    expect(await recoverStaleTasks(db)).toBe(1);
  });
});

describe("scheduler", () => {
  it("matches cron in Asia/Dubai", () => {
    // 05:00 UTC = 09:00 Dubai, Monday 2026-11-09
    expect(cronMatches("0 9 * * 1-5", new Date("2026-11-09T05:00:00Z"), "Asia/Dubai")).toBe(true);
    expect(cronMatches("0 9 * * 1-5", new Date("2026-11-08T05:00:00Z"), "Asia/Dubai")).toBe(false); // Sunday
    expect(latestSlot("15 9 * * *", new Date("2026-11-09T05:00:00Z"), new Date("2026-11-09T05:20:00Z"), "Asia/Dubai")?.toISOString()).toBe("2026-11-09T05:15:00.000Z");
  });

  it("enqueues each slot exactly once", async () => {
    const db = await createTestDb();
    await db.update(schedules).set({ enabled: false });
    await db.update(schedules).set({ enabled: true, lastRunAt: new Date("2026-11-09T04:00:00Z") }).where(eq(schedules.key, "daily_briefing"));
    const now = new Date("2026-11-09T05:00:30Z");
    expect(await runScheduler(db, now)).toEqual(["daily_briefing"]);
    expect(await runScheduler(db, new Date("2026-11-09T05:01:00Z"))).toEqual([]);
    expect(await db.select().from(tasks).where(eq(tasks.type, "briefing.daily"))).toHaveLength(1);
  });
});

describe("agent runtime end-to-end", () => {
  it("lead → qualification → assignment → onboarding → outreach (blocked without an AI key), with office state from real events", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const db = await createTestDb();
    await db.update(schedules).set({ enabled: false });
    await intakeLead(db, strongLead(), await agent(db, "lead_gen_specialist"));
    const r = await tick(db, { workerId: "t", maxTasks: 20 });
    const types = r.executed.map((e) => `${e.type}:${e.status}`);
    expect(types).toEqual(["lead.qualify:completed", "lead.assign:completed", "opportunity.onboard:completed", "outreach.draft:blocked"]);
    const [opp] = await db.select().from(opportunities);
    const owner = (await db.select().from(aiEmployees).where(eq(aiEmployees.id, opp.ownerEmployeeId)))[0];
    expect(owner.isSalesExecutive).toBe(true);
    expect(owner.status).toBe("idle");
    expect(owner.location).toBe("desk");
    const [blocked] = await db.select().from(tasks).where(eq(tasks.status, "blocked"));
    expect(blocked.blockedReason).toMatch(/ANTHROPIC_API_KEY/);
    expect(await db.select().from(interactions)).toHaveLength(0); // nothing fabricated
    expect(await db.select().from(approvals)).toHaveLength(0);
    const started = await db.select().from(activityLog).where(eq(activityLog.action, "task.started"));
    expect(started.length).toBe(4);
    expect(started.some((s) => (s.detail as { location: string }).location === "lead_generation_department")).toBe(true);
  });

  it("refuses to run a task the employee is not authorised for", async () => {
    const db = await createTestDb();
    await db.update(schedules).set({ enabled: false });
    const cgo = await getEmployeeByRole(db, "cgo");
    await createTask(db, { type: "lead.assign", title: "x", assigneeEmployeeId: cgo.id, createdBy: { type: "system" } });
    const r = await tick(db, { workerId: "t" });
    expect(r.executed[0].status).toBe("failed");
    const [t] = await db.select().from(tasks);
    expect(t.error).toMatch(/not authorised/);
  });

  it("KPI plan is blocked until management sets a revenue target", async () => {
    const db = await createTestDb();
    await db.update(schedules).set({ enabled: false });
    const cgo = await getEmployeeByRole(db, "cgo");
    await createTask(db, { type: "kpi.plan", title: "KPI plan", assigneeEmployeeId: cgo.id, createdBy: { type: "system" } });
    const r = await tick(db, { workerId: "t" });
    expect(r.executed[0].status).toBe("blocked");
  });
});
