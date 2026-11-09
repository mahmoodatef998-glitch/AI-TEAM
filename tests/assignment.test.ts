import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountOwners, agentMemories, followUps, opportunities, ownershipHistory, stageTransitions, tasks } from "@/lib/db/schema";
import { assignLead, AssignmentError, chooseSalesExecutive, reassignAccount, type ExecCandidate } from "@/lib/domain/assignment";
import { getEmployeeByRole } from "@/lib/domain/employees";
import { intakeLead, qualifyLead } from "@/lib/domain/leads";
import { remember } from "@/lib/domain/memory";
import { scheduleFollowUp } from "@/lib/domain/pipeline";
import { EMPLOYEES } from "@/lib/org/roster";
import { agent, createTestDb, strongLead } from "./helpers";

const execs: ExecCandidate[] = EMPLOYEES.filter((e) => e.isSalesExecutive).map((e) => ({
  id: e.roleKey,
  name: e.name,
  code: e.code,
  specialization: e.specialization!,
  openOpportunities: 0,
  overdueFollowUps: 0,
}));
const lead = (o: Partial<Parameters<typeof chooseSalesExecutive>[0]>) => ({ industry: null, accountType: null, capacityKvaMax: null, requirementSummary: null, score: 80, ...o });

describe("routing to one of four Sales Executives", () => {
  it("routes by specialization", () => {
    expect(chooseSalesExecutive(lead({ industry: "construction", accountType: "contractor" }), execs).name).toBe("Daniel");
    expect(chooseSalesExecutive(lead({ accountType: "key_account", industry: "government" }), execs).name).toBe("Sarah");
    expect(chooseSalesExecutive(lead({ industry: "data_center", accountType: "end_user", capacityKvaMax: 2000 }), execs).name).toBe("Alex");
    expect(chooseSalesExecutive(lead({ industry: "generator_reseller" }), execs).name).toBe("Michael");
    expect(chooseSalesExecutive(lead({ industry: "manufacturing", accountType: "end_user" }), execs).name).toBe("Michael");
  });

  it("balances workload and excludes executives at capacity", () => {
    const loaded = execs.map((e) => (e.name === "Daniel" ? { ...e, openOpportunities: 30 } : e));
    const d = chooseSalesExecutive(lead({ industry: "construction", accountType: "contractor" }), loaded);
    expect(d.name).not.toBe("Daniel");
    expect(d.ranking.find((r) => r.name === "Daniel")!.reasons).toContain("at capacity");
  });
});

async function qualifiedLead(db: Awaited<ReturnType<typeof createTestDb>>, overrides = {}) {
  const r = await intakeLead(db, strongLead(overrides), await agent(db, "lead_gen_specialist"));
  await qualifyLead(db, r.leadId, await agent(db, "lead_qualification_specialist"));
  return r;
}

describe("assignment & ownership", () => {
  it("creates exactly one owner, an opportunity with next action, a transition and an onboarding task", async () => {
    const db = await createTestDb();
    const r = await qualifiedLead(db);
    const a = await assignLead(db, r.leadId, await agent(db, "sales_director"));
    expect(a.alreadyAssigned).toBe(false);
    const owners = await db.select().from(accountOwners);
    expect(owners).toHaveLength(1);
    const [opp] = await db.select().from(opportunities);
    expect(opp.ownerEmployeeId).toBe(a.employeeId);
    expect(opp.stage).toBe("qualified");
    expect(opp.nextAction).toBeTruthy();
    expect(opp.nextActionDue).toBeTruthy();
    expect(await db.select().from(stageTransitions)).toHaveLength(1);
    const onboard = await db.select().from(tasks).where(eq(tasks.type, "opportunity.onboard"));
    expect(onboard).toHaveLength(1);
    expect(onboard[0].assigneeEmployeeId).toBe(a.employeeId);
    const mem = await db.select().from(agentMemories).where(eq(agentMemories.employeeId, a.employeeId!));
    expect(mem.length).toBeGreaterThan(0);
  });

  it("is idempotent — assigning twice does not create a second opportunity", async () => {
    const db = await createTestDb();
    const r = await qualifiedLead(db);
    const dir = await agent(db, "sales_director");
    await assignLead(db, r.leadId, dir);
    const again = await assignLead(db, r.leadId, dir);
    expect(again.alreadyAssigned).toBe(true);
    expect(await db.select().from(opportunities)).toHaveLength(1);
  });

  it("refuses to auto-assign unqualified leads and non-sales employees", async () => {
    const db = await createTestDb();
    const r = await intakeLead(db, strongLead(), await agent(db, "lead_gen_specialist"));
    await expect(assignLead(db, r.leadId, await agent(db, "sales_director"))).rejects.toBeInstanceOf(AssignmentError);
    const cgo = await getEmployeeByRole(db, "cgo");
    await expect(assignLead(db, r.leadId, { type: "user", id: "00000000-0000-0000-0000-000000000000" }, { overrideEmployeeId: cgo.id })).rejects.toThrow(/Sales Executives/);
  });

  it("reassignment requires a reason, moves open opportunities and follow-ups, and hands over memory", async () => {
    const db = await createTestDb();
    const r = await qualifiedLead(db);
    const dir = await agent(db, "sales_director");
    const a = await assignLead(db, r.leadId, dir);
    const [opp] = await db.select().from(opportunities);
    await scheduleFollowUp(db, opp.id, new Date(Date.now() + 86400_000), "Check in", dir);
    await remember(db, { employeeId: a.employeeId!, kind: "customer_preference", subjectType: "company", subjectId: r.companyId, content: "Prefers Cummins" });
    const sarah = await getEmployeeByRole(db, "sales_exec_sarah");
    const target = a.employeeId === sarah.id ? await getEmployeeByRole(db, "sales_exec_alex") : sarah;
    await expect(reassignAccount(db, r.companyId, target.id, " ", dir)).rejects.toThrow(/reason/);
    await reassignAccount(db, r.companyId, target.id, "Key account restructuring", dir);
    const [o2] = await db.select().from(opportunities);
    expect(o2.ownerEmployeeId).toBe(target.id);
    const [f] = await db.select().from(followUps);
    expect(f.ownerEmployeeId).toBe(target.id);
    expect(await db.select().from(ownershipHistory)).toHaveLength(2);
    const handed = await db.select().from(agentMemories).where(eq(agentMemories.employeeId, target.id));
    expect(handed.some((m) => m.content.includes("Prefers Cummins"))).toBe(true);
  });
});
