import { asc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { modelRoutes, schedules, users } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { createUserAction, logoutAction, modelRouteAction, scheduleAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { Badge, Card, fmtDateTime, PageHeader, Table, Td } from "@/components/ui";
import { integrationStatuses } from "@/lib/integrations/registry";
import { SKILLS } from "@/lib/agents/registry";

const MISSING_INPUTS = [
  "Monthly closed-revenue target (set on the Executive dashboard).",
  "Approved product catalogue with ratings, voltages, canopies and verified prices.",
  "Quotation template, payment terms, validity and warranty wording.",
  "Historical sales data (won/lost deals, values, cycle times) to replace planning assumptions.",
  "Sales Executive territories / specializations and real monthly targets.",
  "Odoo URL, database, user and API key (to prevent duplicate CRM records).",
  "Business email integration (Gmail OAuth) to send approved emails automatically.",
  "Google Search Console, GA4 and Google Ads read access for the marketing team.",
  "Services scope confirmation (maintenance / support offering).",
];

export default async function SettingsPage() {
  const user = await requireUser();
  const db = getDb();
  const ints = integrationStatuses();
  const scheds = await db.select().from(schedules).orderBy(asc(schedules.key));
  const routes = await db.select().from(modelRoutes).orderBy(asc(modelRoutes.profile));
  const team = user.role === "admin" ? await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active }).from(users) : [];
  const admin = user.role === "admin";
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Integrations, operating schedule, model routing and users." actions={<form action={logoutAction}><button className="btn-secondary">Sign out</button></form>} />
      <Card title="Integrations">
        <Table head={["Integration", "Status", "Unlocks", "Requires"]}>
          {ints.map((i) => (
            <tr key={i.key}>
              <Td className="font-medium">{i.name}{i.notes && <div className="text-xs font-normal text-muted">{i.notes}</div>}</Td>
              <Td><Badge tone={i.configured ? "green" : "amber"}>{i.configured ? "Configured" : "Not configured"}</Badge>{i.implementation === "interface_only" && <div className="mt-1"><Badge>interface only</Badge></div>}</Td>
              <Td className="text-xs">{i.unlocks}</Td>
              <Td className="text-xs text-muted">{i.envVars.join(", ") || "—"}</Td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-xs text-muted">Secrets are read from server environment variables only and never sent to the browser.</p>
      </Card>
      <Card title="Inputs needed from 4U">
        <ul className="list-disc space-y-1 pl-5 text-sm">{MISSING_INPUTS.map((m) => <li key={m}>{m}</li>)}</ul>
      </Card>
      <Card title="Operating schedule (Asia/Dubai)">
        <p className="mb-3 text-xs text-muted">Runs while the background worker (<code>npm run worker</code>) or an external scheduler calling <code>POST /api/cron/tick</code> is active — independent of anyone viewing the dashboard.</p>
        <Table head={["Schedule", "Task", "Cron", "Last run", ""]}>
          {scheds.map((s) => (
            <tr key={s.id}>
              <Td className="font-medium">{s.name}</Td>
              <Td className="text-xs">{SKILLS[s.taskType]?.label ?? s.taskType} <span className="text-muted">({s.assigneeRoleKey})</span></Td>
              <Td colSpan={3}>
                {admin ? (
                  <ActionForm action={scheduleAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="scheduleId" value={s.id} />
                    <input name="cron" defaultValue={s.cron} className="field w-36 font-mono text-xs" aria-label="Cron expression" />
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> enabled</label>
                    <span className="text-xs text-muted">last {fmtDateTime(s.lastRunAt)}</span>
                    <Submit variant="secondary">Save</Submit>
                  </ActionForm>
                ) : <span className="font-mono text-xs">{s.cron} {s.enabled ? "" : "(disabled)"} · last {fmtDateTime(s.lastRunAt)}</span>}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Model routing">
        <p className="mb-3 text-xs text-muted">Each task type requests a profile; the profile maps to a provider and model here. Change providers without code changes.</p>
        <div className="space-y-3">
          {routes.map((r) => (
            <ActionForm key={r.profile} action={modelRouteAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="profile" value={r.profile} />
              <div className="w-44"><div className="text-sm font-medium">{r.profile}</div><div className="text-xs text-muted">{r.description}</div></div>
              <Field label="Provider"><select name="provider" defaultValue={r.provider} className="field w-32" disabled={!admin}><option value="anthropic">anthropic</option><option value="xai">xai</option></select></Field>
              <Field label="Model"><input name="model" defaultValue={r.model} className="field w-44" disabled={!admin} /></Field>
              <Field label="Effort"><input name="effort" defaultValue={r.effort ?? ""} className="field w-24" disabled={!admin} /></Field>
              {admin && <Submit variant="secondary">Save</Submit>}
            </ActionForm>
          ))}
        </div>
      </Card>
      {admin && (
        <Card title="Users & roles">
          <Table head={["Name", "Email", "Role", "Active"]}>
            {team.map((u) => <tr key={u.id}><Td>{u.name}</Td><Td>{u.email}</Td><Td><Badge>{u.role}</Badge></Td><Td>{u.active ? "yes" : "no"}</Td></tr>)}
          </Table>
          <ActionForm action={createUserAction} className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-5">
            <Field label="Name"><input name="name" required className="field" /></Field>
            <Field label="Email"><input name="email" type="email" required className="field" /></Field>
            <Field label="Role"><select name="role" className="field"><option value="sales_manager">sales_manager</option><option value="sales_user">sales_user</option><option value="marketing_manager">marketing_manager</option><option value="viewer">viewer</option><option value="admin">admin</option></select></Field>
            <Field label="Initial password (min 10)"><input name="password" type="password" required minLength={10} className="field" /></Field>
            <div className="self-end"><Submit>Create user</Submit></div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
