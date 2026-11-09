import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { accountOwners, aiEmployees, companies, contacts, leadEvidence, leads, opportunities, tasks } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { assignLeadAction, qualifyNowAction, rejectLeadAction, researchLeadAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { A, Badge, Card, Empty, fmtDate, fmtDateTime, humanize, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { listSalesExecutives } from "@/lib/domain/employees";
import { INDUSTRIES } from "@/lib/domain/taxonomy";

export default async function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) notFound();
  const [company] = await db.select().from(companies).where(eq(companies.id, lead.companyId));
  const [ev, cts, [owner], [opp], related, execs] = await Promise.all([
    db.select().from(leadEvidence).where(eq(leadEvidence.leadId, id)).orderBy(desc(leadEvidence.collectedAt)),
    db.select().from(contacts).where(eq(contacts.companyId, company.id)),
    db.select({ name: aiEmployees.name, id: aiEmployees.id, reason: accountOwners.reason }).from(accountOwners).innerJoin(aiEmployees, eq(aiEmployees.id, accountOwners.ownerEmployeeId)).where(eq(accountOwners.companyId, company.id)),
    db.select().from(opportunities).where(eq(opportunities.leadId, id)),
    db.select({ id: tasks.id, title: tasks.title, status: tasks.status, blockedReason: tasks.blockedReason, assignee: aiEmployees.name, updatedAt: tasks.updatedAt }).from(tasks).innerJoin(aiEmployees, eq(aiEmployees.id, tasks.assigneeEmployeeId)).where(eq(tasks.relatedId, id)).orderBy(desc(tasks.createdAt)),
    listSalesExecutives(db),
  ]);
  const canManage = user.role === "admin" || user.role === "sales_manager";
  const open = !["assigned", "duplicate", "rejected"].includes(lead.status);
  return (
    <div className="space-y-6">
      <PageHeader
        title={company.name}
        subtitle={<>{[company.industry ? INDUSTRIES[company.industry]?.label : null, company.city, company.country].filter(Boolean).join(" · ")} {company.website && <> · <a className="text-accent hover:underline" href={company.website} target="_blank" rel="noreferrer">{company.website}</a></>}</>}
        actions={
          open && user.role !== "viewer" ? (
            <>
              <form action={qualifyNowAction.bind(null, id)}><button className="btn-secondary">Re-score</button></form>
              <form action={researchLeadAction.bind(null, id)}><button className="btn-secondary">Request research</button></form>
            </>
          ) : undefined
        }
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Qualification" className="xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="text-3xl font-semibold tabular-nums">{lead.score ?? "—"}<span className="text-base text-muted">/100</span></div>
            {lead.priority && <Badge tone={lead.priority === "high_priority" ? "green" : lead.priority === "qualified" ? "teal" : "amber"}>{humanize(lead.priority)}</Badge>}
            <StatusBadge s={lead.status} />
            <Badge tone="purple">{humanize(lead.signalStrength)}</Badge>
            {lead.scoredAt && <span className="text-xs text-muted">scored {fmtDateTime(lead.scoredAt)}</span>}
          </div>
          {lead.scoreBreakdown ? (
            <Table head={["Criterion", "Points", "Reason"]}>
              {lead.scoreBreakdown.map((b) => (
                <tr key={b.criterion}>
                  <Td className="font-medium">{b.criterion}</Td>
                  <Td className="tabular-nums">{b.points}/{b.max}</Td>
                  <Td className="text-xs text-muted">{b.reason}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="text-sm text-muted">Not scored yet — queued for the Lead Qualification Specialist.</p>
          )}
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Potential requirement</dt><dd>{lead.requirementSummary ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Capacity</dt><dd>{lead.capacityKvaMin || lead.capacityKvaMax ? `${lead.capacityKvaMin ?? "?"}–${lead.capacityKvaMax ?? "?"} kVA` : "—"}</dd></div>
            <div><dt className="text-xs text-muted">Buying signal</dt><dd>{lead.buyingSignal ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Timing</dt><dd>{humanize(lead.purchaseTiming)}</dd></div>
            <div><dt className="text-xs text-muted">Recommended approach</dt><dd>{lead.recommendedApproach ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Source</dt><dd>{humanize(lead.source)} {lead.sourceUrl && <a className="text-accent hover:underline" href={lead.sourceUrl} target="_blank" rel="noreferrer">link</a>}</dd></div>
          </dl>
        </Card>
        <div className="space-y-6">
          <Card title="Ownership">
            {owner ? (
              <p className="text-sm">Owned by <A href={`/employees/${owner.id}`}>{owner.name}</A>{opp && <> · <A href={`/opportunities/${opp.id}`}>open opportunity</A></>}<span className="mt-1 block text-xs text-muted">{owner.reason}</span></p>
            ) : (
              <p className="text-sm text-muted">Not yet assigned. Qualified leads (score ≥ 60) are assigned automatically by the Sales Director.</p>
            )}
            {canManage && !owner && open && (
              <ActionForm action={assignLeadAction} className="mt-3 space-y-2">
                <input type="hidden" name="leadId" value={id} />
                <Field label="Assign to">
                  <select name="employeeId" className="field" defaultValue="">
                    <option value="">Automatic routing (Sales Director rules)</option>
                    {execs.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.title}</option>)}
                  </select>
                </Field>
                <Field label="Reason (for manual assignment)"><input name="reason" className="field" /></Field>
                <Submit>Assign</Submit>
              </ActionForm>
            )}
          </Card>
          {canManage && open && (
            <Card title="Reject lead">
              <ActionForm action={rejectLeadAction} className="space-y-2">
                <input type="hidden" name="leadId" value={id} />
                <Field label="Reason"><input name="reason" required className="field" /></Field>
                <Submit variant="danger">Reject</Submit>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={`Evidence (${ev.length})`}>
          {ev.length === 0 ? <Empty title="No evidence" /> : (
            <ul className="space-y-3 text-sm">
              {ev.map((e) => (
                <li key={e.id}>
                  <a href={e.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">{e.title}</a>
                  <div className="mt-0.5 flex flex-wrap gap-1.5"><Badge>{humanize(e.evidenceType)}</Badge><Badge tone={e.reliability === "high" ? "green" : e.reliability === "low" ? "red" : "amber"}>{e.reliability} reliability</Badge><span className="text-xs text-muted">collected {fmtDate(e.collectedAt)}</span></div>
                  {e.excerpt && <p className="mt-1 text-xs text-muted">{e.excerpt}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Contacts (${cts.length})`}>
          {cts.length === 0 ? <Empty title="No contacts identified" /> : (
            <ul className="space-y-3 text-sm">
              {cts.map((c) => (
                <li key={c.id}>
                  <div className="font-medium">{c.name ?? "Name unknown"} {c.isDecisionMaker && <Badge tone="teal">Decision-maker</Badge>}</div>
                  <div className="text-xs text-muted">{c.jobTitle ?? "Role unknown"}</div>
                  <div className="text-xs">{c.email && <>{c.email} <Badge tone={c.emailStatus === "verified" ? "green" : "amber"}>{c.emailStatus}</Badge></>} {c.phone}</div>
                  <a className="text-xs text-accent hover:underline" href={c.sourceUrl} target="_blank" rel="noreferrer">source</a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Work on this lead">
        {related.length === 0 ? <Empty title="No tasks yet" /> : (
          <Table head={["Task", "Employee", "Status", "Updated"]}>
            {related.map((t) => (
              <tr key={t.id}><Td>{t.title}{t.blockedReason && <div className="text-xs text-warn">{t.blockedReason}</div>}</Td><Td>{t.assignee}</Td><Td><StatusBadge s={t.status} /></Td><Td className="text-xs text-muted">{fmtDateTime(t.updatedAt)}</Td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
