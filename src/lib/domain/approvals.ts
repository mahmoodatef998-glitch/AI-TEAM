import { and, eq, inArray } from "drizzle-orm";
import { aiEmployees, approvals, interactions, opportunities, quotations, tasks, users } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { getEmailSender } from "@/lib/integrations/email";
import { logActivity, type Actor } from "./activity";
import { sendMessage } from "./messaging";
import { addBusinessDays, scheduleFollowUp, stageIndex, transitionOpportunity, type Stage } from "./pipeline";
import { createTask } from "./tasks";

export type ApprovalAction = (typeof approvals.$inferInsert)["action"];
export type UserRole = (typeof users.$inferSelect)["role"];

/** Actions that ALWAYS require a human decision, and which roles may decide them. */
export const APPROVAL_POLICY: Record<ApprovalAction, { label: string; roles: UserRole[] }> = {
  send_external_email: { label: "Send external email", roles: ["admin", "sales_manager"] },
  send_linkedin_message: { label: "Send LinkedIn message", roles: ["admin", "sales_manager"] },
  send_quotation: { label: "Send official quotation", roles: ["admin", "sales_manager"] },
  offer_discount: { label: "Offer discount", roles: ["admin", "sales_manager"] },
  confirm_delivery_date: { label: "Confirm delivery date", roles: ["admin", "sales_manager"] },
  technical_commitment: { label: "Technical commitment", roles: ["admin", "sales_manager"] },
  mark_deal_won: { label: "Mark deal as won", roles: ["admin", "sales_manager"] },
  launch_ad_campaign: { label: "Launch advertising campaign", roles: ["admin", "marketing_manager"] },
  publish_content: { label: "Publish content", roles: ["admin", "marketing_manager"] },
  change_ad_budget: { label: "Change advertising budget", roles: ["admin", "marketing_manager"] },
  change_product_price: { label: "Change product price", roles: ["admin"] },
  sign_agreement: { label: "Sign agreement", roles: ["admin"] },
};

export function canDecide(role: UserRole, action: ApprovalAction) {
  return APPROVAL_POLICY[action].roles.includes(role);
}

export interface ApprovalRequest {
  action: ApprovalAction;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  requestedByEmployeeId?: string | null;
  requestedByUserId?: string | null;
  taskId?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
}

export async function requestApproval(db: DB, r: ApprovalRequest) {
  // One pending approval per action+subject: avoid flooding approvers with duplicates.
  if (r.relatedId) {
    const [dupe] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.action, r.action), eq(approvals.relatedId, r.relatedId), eq(approvals.status, "pending")));
    if (dupe && JSON.stringify(dupe.payload) === JSON.stringify(r.payload ?? {})) return dupe;
  }
  const [a] = await db
    .insert(approvals)
    .values({
      action: r.action,
      title: r.title,
      summary: r.summary,
      payload: r.payload ?? {},
      requestedByEmployeeId: r.requestedByEmployeeId ?? null,
      requestedByUserId: r.requestedByUserId ?? null,
      taskId: r.taskId ?? null,
      relatedType: r.relatedType ?? null,
      relatedId: r.relatedId ?? null,
    })
    .returning();
  const actor: Actor = r.requestedByEmployeeId ? { type: "agent", id: r.requestedByEmployeeId } : r.requestedByUserId ? { type: "user", id: r.requestedByUserId } : { type: "system" };
  await logActivity(db, actor, "approval.requested", `Approval requested: ${r.title}`, {
    entityType: "approval",
    entityId: a.id,
    detail: { action: r.action },
  });
  return a;
}

export class ApprovalError extends Error {}

/** Record a human decision and execute its effect. Every decision is logged. */
export async function decideApproval(
  db: DB,
  approvalId: string,
  decision: "approved" | "rejected",
  user: { id: string; role: UserRole; name: string },
  note?: string,
) {
  const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!a) throw new ApprovalError("Approval not found");
  if (a.status !== "pending") throw new ApprovalError(`Approval already ${a.status}`);
  if (!canDecide(user.role, a.action)) throw new ApprovalError(`Your role (${user.role}) cannot decide '${APPROVAL_POLICY[a.action].label}'.`);
  if (decision === "rejected" && !note?.trim()) throw new ApprovalError("Please give a reason when rejecting, so the AI employee can revise.");

  const actor: Actor = { type: "user", id: user.id };
  const updated = await db
    .update(approvals)
    .set({ status: decision, decidedByUserId: user.id, decidedAt: new Date(), decisionNote: note ?? null })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning();
  if (updated.length === 0) throw new ApprovalError("Approval was decided concurrently");
  await logActivity(db, actor, `approval.${decision}`, `${user.name} ${decision} "${a.title}"`, {
    entityType: "approval",
    entityId: a.id,
    detail: { action: a.action, note: note ?? null },
  });

  let execution: { status: "executed" | "manual_required" | "failed" | null; detail: string | null } = { status: null, detail: null };
  if (decision === "approved") execution = await executeApproved(db, a, actor);
  else await handleRejected(db, a, actor, note!);

  if (execution.status) {
    await db.update(approvals).set({ executionStatus: execution.status, executionDetail: execution.detail }).where(eq(approvals.id, a.id));
  }
  if (a.taskId) {
    await db
      .update(tasks)
      .set({
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        output: { approval: decision, note: note ?? null, execution: execution.status, executionDetail: execution.detail },
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, a.taskId), eq(tasks.status, "waiting_approval")));
  }
  if (a.requestedByEmployeeId) {
    await db
      .update(aiEmployees)
      .set({ status: "idle", location: "desk", currentTaskId: null, statusDetail: null })
      .where(and(eq(aiEmployees.id, a.requestedByEmployeeId), eq(aiEmployees.status, "waiting_approval")));
    await sendMessage(db, {
      fromUserId: user.id,
      toEmployeeId: a.requestedByEmployeeId,
      kind: "message",
      subject: `${decision === "approved" ? "Approved" : "Rejected"}: ${a.title}`,
      body:
        decision === "approved"
          ? `Approved by ${user.name}.${execution.detail ? ` ${execution.detail}` : ""}${note ? ` Note: ${note}` : ""}`
          : `Rejected by ${user.name}. Feedback: ${note}`,
      relatedType: a.relatedType,
      relatedId: a.relatedId,
    });
  }
  return { decision, execution };
}

async function executeApproved(db: DB, a: typeof approvals.$inferSelect, actor: Actor) {
  const p = a.payload as Record<string, unknown>;
  switch (a.action) {
    case "send_external_email":
    case "send_linkedin_message": {
      const interactionId = p.interactionId as string | undefined;
      if (!interactionId) return { status: "failed" as const, detail: "No interaction attached to approval." };
      await db.update(interactions).set({ status: "approved", approvalId: a.id }).where(eq(interactions.id, interactionId));
      const [ix] = await db.select().from(interactions).where(eq(interactions.id, interactionId));
      const sender = getEmailSender();
      const to = p.toEmail as string | undefined;
      if (a.action === "send_external_email" && sender && to) {
        try {
          await sender.send({ to, subject: ix.subject ?? "", body: ix.body ?? "" });
          await markInteractionSent(db, interactionId, actor);
          return { status: "executed" as const, detail: `Email sent to ${to} via ${sender.name}.` };
        } catch (e) {
          return { status: "failed" as const, detail: `Email dispatch failed: ${(e as Error).message}. Send manually, then mark as sent.` };
        }
      }
      return {
        status: "manual_required" as const,
        detail:
          a.action === "send_linkedin_message"
            ? "LinkedIn messaging has no permitted API integration: send it manually, then click 'Mark as sent' on the opportunity."
            : !to
              ? "No verified recipient email on file: send manually, then click 'Mark as sent'."
              : "Email integration not configured: send it from the company mailbox, then click 'Mark as sent'.",
      };
    }
    case "send_quotation": {
      const quotationId = p.quotationId as string | undefined;
      if (quotationId) await db.update(quotations).set({ status: "approved", approvalId: a.id, updatedAt: new Date() }).where(eq(quotations.id, quotationId));
      return { status: "manual_required" as const, detail: "Quotation approved. Send it to the customer, then mark the opportunity as Quotation Sent." };
    }
    case "mark_deal_won": {
      const opportunityId = a.relatedId!;
      await transitionOpportunity(db, opportunityId, "won", actor, {
        wonApprovalId: a.id,
        wonEvidence: (p.wonEvidence as string) ?? undefined,
        actualValueAed: (p.actualValueAed as string) ?? undefined,
        note: "Approved as won",
      });
      return { status: "executed" as const, detail: "Opportunity marked as Won." };
    }
    default:
      return { status: "manual_required" as const, detail: "Approved. No automated integration is connected for this action — execute it manually." };
  }
}

async function handleRejected(db: DB, a: typeof approvals.$inferSelect, actor: Actor, note: string) {
  const p = a.payload as Record<string, unknown>;
  if ((a.action === "send_external_email" || a.action === "send_linkedin_message") && p.interactionId) {
    await db.update(interactions).set({ status: "rejected", approvalId: a.id }).where(eq(interactions.id, p.interactionId as string));
    if (a.relatedType === "opportunity" && a.relatedId && a.requestedByEmployeeId) {
      await db
        .update(opportunities)
        .set({ nextAction: "Revise outreach draft per approver feedback", nextActionDue: addBusinessDays(new Date(), 1), updatedAt: new Date() })
        .where(eq(opportunities.id, a.relatedId));
      // Revision loop: the same Sales Executive redrafts with the feedback.
      await createTask(db, {
        type: "outreach.draft",
        title: "Revise outreach draft",
        assigneeEmployeeId: a.requestedByEmployeeId,
        createdBy: actor,
        relatedType: "opportunity",
        relatedId: a.relatedId,
        priority: 7,
        input: { opportunityId: a.relatedId, channel: p.channel ?? "email", feedback: note, previousInteractionId: p.interactionId },
        dedupeKey: `outreach:opp:${a.relatedId}`,
      });
    }
  }
  if (a.action === "send_quotation" && p.quotationId) {
    await db.update(quotations).set({ status: "rejected", updatedAt: new Date() }).where(eq(quotations.id, p.quotationId as string));
  }
}

/** A human confirms an approved message was actually sent (manual dispatch). */
export async function markInteractionSent(db: DB, interactionId: string, actor: Actor) {
  const [ix] = await db.select().from(interactions).where(eq(interactions.id, interactionId));
  if (!ix) throw new ApprovalError("Interaction not found");
  if (!["approved", "sent"].includes(ix.status)) throw new ApprovalError("Only approved messages can be marked as sent.");
  await db.update(interactions).set({ status: "sent", occurredAt: new Date() }).where(eq(interactions.id, interactionId));
  await logActivity(db, actor, "interaction.sent", `Outbound ${ix.channel} marked as sent: ${ix.subject ?? ""}`, {
    entityType: "opportunity",
    entityId: ix.opportunityId,
  });
  if (ix.opportunityId) {
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, ix.opportunityId));
    const due = addBusinessDays(new Date(), 3);
    if (opp && stageIndex(opp.stage as Stage) < stageIndex("contacted")) {
      await transitionOpportunity(db, opp.id, "contacted", actor, {
        note: "Initial outreach sent",
        nextAction: "Follow up on initial outreach",
        nextActionDue: due,
      });
    } else if (opp) {
      await db.update(opportunities).set({ lastActivityAt: new Date(), nextAction: "Follow up on last message", nextActionDue: due }).where(eq(opportunities.id, opp.id));
    }
    if (opp) await scheduleFollowUp(db, opp.id, due, `Follow up on: ${ix.subject ?? "outreach"}`, actor);
  }
}

export async function pendingApprovalCount(db: DB) {
  const rows = await db.select({ id: approvals.id }).from(approvals).where(inArray(approvals.status, ["pending"]));
  return rows.length;
}
