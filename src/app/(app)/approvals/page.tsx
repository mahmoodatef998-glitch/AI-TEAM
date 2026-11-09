import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { aiEmployees, approvals, interactions, users } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { decideApprovalAction } from "@/app/actions";
import { ActionForm } from "@/components/forms";
import { A, Badge, Card, Empty, fmtDateTime, PageHeader, StatusBadge } from "@/components/ui";
import { APPROVAL_POLICY, canDecide } from "@/lib/domain/approvals";

export default async function ApprovalsPage() {
  const user = await requireUser();
  const db = getDb();
  const pending = await db
    .select({ a: approvals, emp: aiEmployees.name, empId: aiEmployees.id })
    .from(approvals)
    .leftJoin(aiEmployees, eq(aiEmployees.id, approvals.requestedByEmployeeId))
    .where(eq(approvals.status, "pending"))
    .orderBy(approvals.createdAt);
  const ixIds = pending.map((p) => (p.a.payload as { interactionId?: string }).interactionId).filter(Boolean) as string[];
  const ixRows = ixIds.length ? await db.select().from(interactions).where(inArray(interactions.id, ixIds)) : [];
  const recent = await db
    .select({ a: approvals, decider: users.name })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.decidedByUserId))
    .where(inArray(approvals.status, ["approved", "rejected"]))
    .orderBy(desc(approvals.decidedAt))
    .limit(30);
  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" subtitle="External communication, quotations, prices, discounts, delivery/technical commitments, campaigns, publishing and won deals always require a human decision." />
      <Card title={`Pending (${pending.length})`}>
        {pending.length === 0 ? <Empty title="Nothing waiting for approval" /> : (
          <div className="space-y-4">
            {pending.map(({ a, emp, empId }) => {
              const p = a.payload as Record<string, unknown>;
              const ix = ixRows.find((i) => i.id === p.interactionId);
              const allowed = canDecide(user.role, a.action);
              return (
                <article key={a.id} className="rounded-md border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="amber">{APPROVAL_POLICY[a.action].label}</Badge>
                    <span className="font-medium">{a.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted">Requested {fmtDateTime(a.createdAt)} by {emp && empId ? <A href={`/employees/${empId}`}>{emp}</A> : "a user"}{a.relatedType === "opportunity" && a.relatedId && <> · <A href={`/opportunities/${a.relatedId}`}>opportunity</A></>}</div>
                  <p className="mt-2 text-sm">{a.summary}</p>
                  {ix && (
                    <div className="mt-3 rounded-md bg-surface-2 p-3 text-sm">
                      <div className="text-xs text-muted">{ix.channel} draft{p.toEmail ? ` to ${String(p.toEmail)} (${String(p.toEmailStatus ?? "unverified")})` : " — no email on file"}</div>
                      {ix.subject && <div className="mt-1 font-medium">{ix.subject}</div>}
                      <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{ix.body}</pre>
                    </div>
                  )}
                  {Array.isArray(p.needsHumanInput) && p.needsHumanInput.length > 0 && <p className="mt-2 text-xs text-warn">Needs human input: {(p.needsHumanInput as string[]).join("; ")}</p>}
                  {Array.isArray(p.claimsUsed) && p.claimsUsed.length > 0 && <p className="mt-1 text-xs text-muted">Company claims used: {(p.claimsUsed as string[]).join("; ")}</p>}
                  {!ix && a.action === "publish_content" && typeof p.body === "string" && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 font-sans text-sm">{p.body}</pre>}
                  {allowed ? (
                    <ActionForm action={decideApprovalAction} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="approvalId" value={a.id} />
                      <label className="min-w-64 flex-1"><span className="label">Note (required to reject)</span><input name="note" className="field" /></label>
                      <button name="decision" value="approved" className="btn">Approve</button>
                      <button name="decision" value="rejected" className="btn-danger">Reject</button>
                    </ActionForm>
                  ) : (
                    <p className="mt-3 text-xs text-muted">Your role ({user.role}) cannot decide this. Allowed: {APPROVAL_POLICY[a.action].roles.join(", ")}.</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Card>
      <Card title="Recent decisions">
        {recent.length === 0 ? <p className="text-sm text-muted">No decisions yet.</p> : (
          <ul className="space-y-2 text-sm">
            {recent.map(({ a, decider }) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <StatusBadge s={a.status} /> {a.title} <span className="text-xs text-muted">by {decider} · {fmtDateTime(a.decidedAt)}{a.decisionNote ? ` — “${a.decisionNote}”` : ""}</span>
                {a.executionStatus && <StatusBadge s={a.executionStatus} />}
                {a.executionDetail && <span className="text-xs text-muted">{a.executionDetail}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
