import { asc, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { aiEmployees, companies, contacts, followUps, interactions, opportunities, rfqs, stageTransitions, users } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { completeFollowUpAction, followUpAction, logInteractionAction, manualOutreachAction, markSentAction, nextActionAction, reassignAction, receiveRfqAction, requestWonAction, setValueAction, transitionAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { A, Avatar, Badge, Card, Empty, fmtAed, fmtDate, fmtDateTime, humanize, PageHeader, StatusBadge, Table, Td } from "@/components/ui";
import { listSalesExecutives } from "@/lib/domain/employees";
import { STAGES, stageLabel, TERMINAL_STAGES, type Stage } from "@/lib/domain/pipeline";

const toLocalInput = (d: Date | null) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, id));
  if (!opp) notFound();
  const [[company], [owner], cts, ix, fus, trans, rfqRows, execs] = await Promise.all([
    db.select().from(companies).where(eq(companies.id, opp.companyId)),
    db.select().from(aiEmployees).where(eq(aiEmployees.id, opp.ownerEmployeeId)),
    db.select().from(contacts).where(eq(contacts.companyId, opp.companyId)),
    db.select({ i: interactions, emp: aiEmployees.name, usr: users.name }).from(interactions).leftJoin(aiEmployees, eq(aiEmployees.id, interactions.employeeId)).leftJoin(users, eq(users.id, interactions.userId)).where(eq(interactions.companyId, opp.companyId)).orderBy(desc(interactions.occurredAt)),
    db.select().from(followUps).where(eq(followUps.opportunityId, id)).orderBy(asc(followUps.dueAt)),
    db.select().from(stageTransitions).where(eq(stageTransitions.opportunityId, id)).orderBy(desc(stageTransitions.createdAt)),
    db.select().from(rfqs).where(eq(rfqs.opportunityId, id)).orderBy(desc(rfqs.receivedAt)),
    listSalesExecutives(db),
  ]);
  const closed = TERMINAL_STAGES.includes(opp.stage as Stage);
  const canWrite = user.role !== "viewer";
  const canManage = user.role === "admin" || user.role === "sales_manager";
  return (
    <div className="space-y-6">
      <PageHeader
        title={opp.title}
        subtitle={<><A href={`/leads/${opp.leadId}`}>{company.name}</A> · {stageLabel(opp.stage)} · probability {opp.probability ?? "—"}%</>}
        actions={<div className="flex items-center gap-2 text-sm"><Avatar name={owner.name} color={owner.avatarColor} /> Owner: <A href={`/employees/${owner.id}`}>{owner.name}</A></div>}
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Status" className="xl:col-span-2">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted">Stage</dt><dd><StatusBadge s={opp.stage} /></dd></div>
            <div><dt className="text-xs text-muted">Next action</dt><dd className={opp.nextActionDue && opp.nextActionDue < new Date() ? "text-danger" : ""}>{opp.nextAction ?? "—"}<div className="text-xs text-muted">{fmtDateTime(opp.nextActionDue)}</div></dd></div>
            <div><dt className="text-xs text-muted">Expected value</dt><dd>{fmtAed(opp.expectedValueAed)} {opp.expectedValueAed && opp.valueIsEstimate && <Badge tone="amber">estimate</Badge>}</dd></div>
            <div><dt className="text-xs text-muted">Capacity / brand</dt><dd>{opp.capacityKva ? `${opp.capacityKva} kVA` : "—"} · {opp.brandPreference ?? "no preference"}</dd></div>
            <div><dt className="text-xs text-muted">Expected close</dt><dd>{fmtDate(opp.expectedCloseDate)}</dd></div>
            <div><dt className="text-xs text-muted">Last activity</dt><dd>{fmtDateTime(opp.lastActivityAt)}</dd></div>
            {opp.lostReason && <div className="sm:col-span-3"><dt className="text-xs text-muted">Lost reason</dt><dd>{opp.lostReason}</dd></div>}
            {opp.wonEvidence && <div className="sm:col-span-3"><dt className="text-xs text-muted">Won evidence</dt><dd>{opp.wonEvidence} · actual {fmtAed(opp.actualValueAed)}</dd></div>}
          </dl>
        </Card>
        <Card title="Contacts">
          {cts.length === 0 ? <p className="text-sm text-muted">No contacts yet.</p> : (
            <ul className="space-y-2 text-sm">{cts.map((c) => <li key={c.id}><div className="font-medium">{c.name ?? "Name unknown"}</div><div className="text-xs text-muted">{c.jobTitle} {c.email && `· ${c.email} (${c.emailStatus})`} {c.phone}</div></li>)}</ul>
          )}
        </Card>
      </div>

      {canWrite && !closed && (
        <div className="grid gap-6 xl:grid-cols-3">
          <Card title="Move stage">
            <ActionForm action={transitionAction}>
              <input type="hidden" name="opportunityId" value={id} />
              <Field label="New stage">
                <select name="stage" className="field" defaultValue="">
                  <option value="" disabled>Select…</option>
                  {STAGES.filter((s) => s.key !== opp.stage && s.key !== "won").map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Next action"><input name="nextAction" defaultValue={opp.nextAction ?? ""} className="field" /></Field>
              <Field label="Due"><input name="nextActionDue" type="datetime-local" defaultValue={toLocalInput(opp.nextActionDue)} className="field" /></Field>
              <Field label="Lost / disqualified reason"><input name="lostReason" className="field" /></Field>
              <Field label="Note"><input name="note" className="field" /></Field>
              <p className="text-xs text-muted">Won is set only through an approved “mark won” request with evidence.</p>
              <Submit>Update stage</Submit>
            </ActionForm>
          </Card>
          <Card title="Next action & value">
            <ActionForm action={nextActionAction}>
              <input type="hidden" name="opportunityId" value={id} />
              <Field label="Next action"><input name="nextAction" defaultValue={opp.nextAction ?? ""} className="field" /></Field>
              <Field label="Due"><input name="nextActionDue" type="datetime-local" defaultValue={toLocalInput(opp.nextActionDue)} className="field" /></Field>
              <Submit variant="secondary">Save next action</Submit>
            </ActionForm>
            {canManage && (
              <ActionForm action={setValueAction} className="mt-4 space-y-3 border-t border-border pt-4">
                <input type="hidden" name="opportunityId" value={id} />
                <Field label="Expected value (AED)"><input name="expectedValueAed" type="number" min="0" defaultValue={opp.expectedValueAed ?? ""} className="field" /></Field>
                <Field label="Expected close date"><input name="expectedCloseDate" type="date" defaultValue={opp.expectedCloseDate ?? ""} className="field" /></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="valueIsEstimate" defaultChecked={opp.valueIsEstimate} /> Value is an estimate</label>
                <Submit variant="secondary">Save value</Submit>
              </ActionForm>
            )}
          </Card>
          <Card title="Record interaction">
            <ActionForm action={logInteractionAction}>
              <input type="hidden" name="opportunityId" value={id} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Channel"><select name="channel" className="field"><option>email</option><option>phone</option><option>meeting</option><option>linkedin</option><option>note</option></select></Field>
                <Field label="Direction"><select name="direction" className="field"><option value="inbound">Inbound (customer → us)</option><option value="outbound">Outbound (logged)</option><option value="internal">Internal note</option></select></Field>
              </div>
              <Field label="Subject"><input name="subject" className="field" /></Field>
              <Field label="Details"><textarea name="body" rows={3} className="field" /></Field>
              <Submit variant="secondary">Record</Submit>
            </ActionForm>
          </Card>
        </div>
      )}

      {canWrite && !closed && cts.length > 0 && (
        <Card title="Write outreach yourself (no AI needed) — goes to approval">
          <ActionForm action={manualOutreachAction}>
            <input type="hidden" name="opportunityId" value={id} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="To"><select name="contactId" className="field">{cts.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.jobTitle ?? "Contact"}{c.email ? ` — ${c.email}` : ""}</option>)}</select></Field>
              <Field label="Channel"><select name="channel" className="field"><option value="email">Email</option><option value="linkedin">LinkedIn</option></select></Field>
              <Field label="Subject"><input name="subject" className="field" /></Field>
            </div>
            <Field label="Message"><textarea name="body" rows={5} required className="field" /></Field>
            <p className="text-xs text-muted">Nothing is sent until an approver approves it. Without an email integration you then send it yourself and click “Mark as sent”.</p>
            <Submit>Send for approval</Submit>
          </ActionForm>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={`Communication history (${ix.length})`}>
          {ix.length === 0 ? <Empty title="No interactions yet" /> : (
            <ul className="space-y-3">
              {ix.map(({ i, emp, usr }) => (
                <li key={i.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge>{i.channel}</Badge><Badge tone="purple">{i.direction}</Badge><StatusBadge s={i.status} />
                    <span className="text-muted">{fmtDateTime(i.occurredAt)} · {emp ?? usr ?? "—"}</span>
                  </div>
                  {i.subject && <div className="mt-1 font-medium">{i.subject}</div>}
                  {i.body && <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{i.body}</p>}
                  {i.status === "approved" && canWrite && (
                    <form action={markSentAction.bind(null, i.id, id)} className="mt-2"><button className="btn-secondary">Mark as sent</button></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Follow-ups">
            {fus.length === 0 ? <p className="text-sm text-muted">No follow-ups scheduled.</p> : (
              <ul className="space-y-2 text-sm">
                {fus.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span><StatusBadge s={f.status === "pending" && f.dueAt < new Date() ? "missed" : f.status} /> {f.purpose} · {fmtDateTime(f.dueAt)}</span>
                    {f.status === "pending" && canWrite && (
                      <ActionForm action={completeFollowUpAction} className="flex gap-2">
                        <input type="hidden" name="followUpId" value={f.id} />
                        <input name="outcome" placeholder="Outcome" className="field w-36" />
                        <Submit variant="secondary">Done</Submit>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canWrite && !closed && (
              <ActionForm action={followUpAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
                <input type="hidden" name="opportunityId" value={id} />
                <Field label="Due"><input name="dueAt" type="datetime-local" required className="field" /></Field>
                <Field label="Purpose"><input name="purpose" required className="field" /></Field>
                <Submit variant="secondary">Schedule</Submit>
              </ActionForm>
            )}
          </Card>
          <Card title="Stage history">
            <ul className="space-y-1.5 text-xs">
              {trans.map((t) => <li key={t.id}><span className="text-muted">{fmtDateTime(t.createdAt)}</span> · {t.fromStage ? `${stageLabel(t.fromStage)} → ` : ""}<strong>{stageLabel(t.toStage)}</strong> <span className="text-muted">({t.actorType}){t.note ? ` — ${t.note}` : ""}</span></li>)}
            </ul>
          </Card>
        </div>
      </div>

      <Card title={`RFQs (${rfqRows.length})`}>
        {rfqRows.map((r) => (
          <div key={r.id} className="mb-4 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge s={r.status} /><span className="text-xs text-muted">received {fmtDateTime(r.receivedAt)} · extraction: {r.extractionMethod ?? "pending"}</span></div>
            {r.missingInfo && r.missingInfo.length > 0 && <p className="mt-2"><strong>Missing:</strong> {r.missingInfo.join(", ")}</p>}
            {r.conflicts && r.conflicts.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-warn">{r.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            {r.customerQuestions && r.customerQuestions.length > 0 && <div className="mt-2"><strong className="text-xs">Questions for the customer</strong><ul className="list-disc pl-5 text-xs">{r.customerQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
            {r.complianceMatrix != null && (
              <div className="mt-3">
                <Table head={["Parameter", "Required", "Offered", "Status"]}>
                  {((r.complianceMatrix as { rows: { parameter: string; required: string; offered: string; status: string; note?: string }[] }).rows ?? []).map((row) => (
                    <tr key={row.parameter}><Td>{row.parameter}</Td><Td>{row.required}</Td><Td>{row.offered}{row.note && <div className="text-xs text-muted">{row.note}</div>}</Td><Td><Badge tone={row.status === "complies" ? "green" : row.status === "deviation" ? "red" : "amber"}>{humanize(row.status)}</Badge></Td></tr>
                  ))}
                </Table>
              </div>
            )}
          </div>
        ))}
        {canWrite && !closed && (
          <ActionForm action={receiveRfqAction} className="space-y-3">
            <input type="hidden" name="opportunityId" value={id} />
            <Field label="RFQ text (paste the customer's request)"><textarea name="rawText" rows={4} className="field" /></Field>
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">Enter structured requirements instead (no AI needed)</summary>
              <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" name="structured" /> Use these fields</label>
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                {[["quantity", "Quantity"], ["standbyKva", "Standby kVA"], ["primeKva", "Prime kVA"], ["frequencyHz", "Frequency Hz"], ["voltage", "Voltage"], ["phase", "Phase"], ["brandPreference", "Brand"], ["canopy", "Canopy"], ["fuelTankHours", "Fuel autonomy h"], ["atsRatingA", "ATS rating A"], ["ambientTempC", "Ambient °C"], ["deliveryLocation", "Delivery location"]].map(([n, l]) => <Field key={n} label={l}><input name={n} className="field" /></Field>)}
                {[["ats", "ATS required"], ["synchronization", "Synchronisation"], ["installationRequired", "Installation"]].map(([n, l]) => <Field key={n} label={l}><select name={n} className="field" defaultValue=""><option value="">Not stated</option><option value="yes">Yes</option><option value="no">No</option></select></Field>)}
              </div>
            </details>
            <Submit>Record RFQ</Submit>
          </ActionForm>
        )}
      </Card>

      {canWrite && !closed && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Request “mark as won” (approval required)">
            <ActionForm action={requestWonAction}>
              <input type="hidden" name="opportunityId" value={id} />
              <Field label="Verified evidence" hint="PO number, signed order, or payment reference"><input name="wonEvidence" required className="field" /></Field>
              <Field label="Actual value (AED)"><input name="actualValueAed" type="number" min="0" className="field" /></Field>
              <Submit variant="secondary">Request approval</Submit>
            </ActionForm>
          </Card>
          {canManage && (
            <Card title="Reassign account (Sales Director decision)">
              <ActionForm action={reassignAction}>
                <input type="hidden" name="companyId" value={company.id} />
                <Field label="New owner"><select name="employeeId" className="field">{execs.filter((e) => e.id !== owner.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
                <Field label="Reason (recorded)"><input name="reason" required className="field" /></Field>
                <Submit variant="secondary">Reassign</Submit>
              </ActionForm>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
