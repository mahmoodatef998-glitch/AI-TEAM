import { eq } from "drizzle-orm";
import { contacts, interactions, opportunities } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { logActivity } from "./activity";
import { requestApproval } from "./approvals";
import { addBusinessDays, stageIndex, TERMINAL_STAGES, transitionOpportunity, type Stage } from "./pipeline";

export class OutreachError extends Error {}

/**
 * A human writes an outbound message themselves (no AI model needed). It goes through exactly the
 * same approval gate as AI drafts: interaction "pending_approval" → approval request → human decision.
 */
export async function submitManualOutreach(
  db: DB,
  input: { opportunityId: string; contactId: string; channel: "email" | "linkedin"; subject?: string | null; body: string },
  userId: string,
) {
  if (!input.body?.trim()) throw new OutreachError("Message text is required.");
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, input.opportunityId));
  if (!opp) throw new OutreachError("Opportunity not found.");
  if (TERMINAL_STAGES.includes(opp.stage as Stage)) throw new OutreachError("This opportunity is closed.");
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, input.contactId));
  if (!contact || contact.companyId !== opp.companyId) throw new OutreachError("Choose a contact from this company.");
  if (input.channel === "email" && !contact.email) throw new OutreachError("This contact has no email on file — choose LinkedIn or add an email.");

  const actor = { type: "user" as const, id: userId };
  const [ix] = await db
    .insert(interactions)
    .values({
      opportunityId: opp.id,
      companyId: opp.companyId,
      contactId: contact.id,
      userId,
      channel: input.channel,
      direction: "outbound",
      status: "pending_approval",
      subject: input.subject?.trim() || null,
      body: input.body.trim(),
    })
    .returning();

  const due = addBusinessDays(new Date(), 1);
  if (stageIndex(opp.stage as Stage) < stageIndex("initial_contact_drafted")) {
    await transitionOpportunity(db, opp.id, "initial_contact_drafted", actor, { note: "Outreach written manually", nextAction: "Outreach awaiting approval", nextActionDue: due });
  }
  const [now] = await db.select().from(opportunities).where(eq(opportunities.id, opp.id));
  if (now.stage === "initial_contact_drafted") {
    await transitionOpportunity(db, opp.id, "awaiting_approval", actor, { note: "Submitted for approval", nextAction: "Outreach awaiting approval", nextActionDue: due });
  }

  const approval = await requestApproval(db, {
    action: input.channel === "email" ? "send_external_email" : "send_linkedin_message",
    title: `Outreach to ${contact.name ?? contact.jobTitle ?? "contact"} (written manually)`,
    summary: `Manually written ${input.channel} message for ${opp.title}.`,
    payload: { interactionId: ix.id, channel: input.channel, toEmail: contact.email ?? null, toEmailStatus: contact.emailStatus, manual: true },
    requestedByUserId: userId,
    relatedType: "opportunity",
    relatedId: opp.id,
  });
  await db.update(interactions).set({ approvalId: approval.id }).where(eq(interactions.id, ix.id));
  await logActivity(db, actor, "outreach.manual_submitted", `Manual ${input.channel} outreach submitted for approval: ${opp.title}`, {
    entityType: "opportunity",
    entityId: opp.id,
  });
  return { interactionId: ix.id, approvalId: approval.id };
}
