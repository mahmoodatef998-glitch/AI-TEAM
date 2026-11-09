import type { DB } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/activity";
import type { Employee } from "@/lib/domain/employees";
import type { Task } from "@/lib/domain/tasks";

export type EmployeeStatus =
  | "working" | "researching" | "writing" | "analyzing" | "contacting_customer"
  | "preparing_quotation" | "in_meeting";

export type OfficeLocation =
  | "desk" | "executive_office" | "sales_department" | "marketing_department"
  | "lead_generation_department" | "research_department" | "meeting_room" | "operations_room";

export interface SkillContext {
  db: DB;
  task: Task;
  employee: Employee;
  /** The employee as an actor, for audit logging. */
  actor: Actor;
  progress(pct: number, detail?: string): Promise<void>;
}

export type SkillResult =
  | { status: "completed"; summary: string; output?: Record<string, unknown> }
  /** Cannot proceed until a human provides data, credentials or an integration. */
  | { status: "blocked"; reason: string; output?: Record<string, unknown> }
  | { status: "waiting_approval"; approvalId: string; summary: string; output?: Record<string, unknown> };

export interface Skill {
  type: string;
  label: string;
  /** How the employee appears in the virtual office while executing this skill. */
  office: { status: EmployeeStatus; location: OfficeLocation };
  /** Integrations this skill needs (for documentation / settings page). */
  requires?: string[];
  run(ctx: SkillContext): Promise<SkillResult>;
}

export class NonRetryableError extends Error {}
