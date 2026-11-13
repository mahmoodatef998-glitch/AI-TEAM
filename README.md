# 4U AI Workforce

An AI-powered marketing and sales organisation for **4U Power Generation FZC** (SAIF Zone, Sharjah, UAE). It has 16 AI employees in 6 departments, including a Sales Director and **four independent Sales Executives** (Alex, Daniel, Michael and Sarah). Each employee has a defined role, permitted skills, persistent memory, a task queue and an audit trail. A PixiJS virtual office shows what they are doing, and it is driven only by real task state.

> The system invents no leads, customers, prices, specifications or results. It seeds no sample sales data. Anything that needs a missing integration or missing data shows up as a **blocked task with the reason**, not as a fake result.

## Quick start

```bash
cp .env.example .env.local        # set DATABASE_URL (PostgreSQL 14+), ADMIN_PASSWORD, CRON_SECRET
npm install
npm run db:migrate                # applies drizzle/ migrations
npm run db:seed                   # departments, 16 AI employees, schedules, model routes, admin user
npm run build && npm start        # web app on :3000
npm run worker                    # background worker: schedules + AI task queue (keep running)
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is unset, the seed prints a generated password once.

You don't need a separate worker host. Instead, call `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute from Vercel Cron, n8n or any other scheduler. Actions in the UI also start the queue right after they respond.

| Command | Purpose |
|---|---|
| `npm test` | Tests on in-process PostgreSQL (PGlite) using the real migrations |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint (zero warnings) |
| `npm run db:generate` | Generate a migration after editing `src/lib/db/schema.ts` |

### Health check

`GET /api/health` returns `{"status":"ok"}` (200) or `{"status":"error"}` (503), for uptime monitors. With `Authorization: Bearer $CRON_SECRET` it also explains why the database is or is not reachable (DNS, TLS, password, pooler user, missing tables, missing seed) and which optional keys are set. It never returns secret values.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/health
```

### Deploying on Vercel with Supabase

- Use Supabase's **Transaction pooler** URL (port 6543, user `postgres.<project-ref>`). The direct host `db.<ref>.supabase.co` is IPv6-only and Vercel cannot reach it.
- Append `?sslmode=require&uselibpqcompat=true`. Without `uselibpqcompat`, node-postgres treats `require` as full certificate verification and rejects Supabase's CA.
- Set the Vercel Function Region to the one closest to the database (for `ap-south-1`, choose `bom1`).
- The app talks to Postgres directly as the table owner, so Supabase's Data API (anon/authenticated keys) must not reach these tables. On a new Supabase project, enable RLS on every `public` table and revoke `anon` and `authenticated` grants, including default privileges for tables created by later migrations.

## Team chat and office life

- **Team chat** (`/team`): message any AI employee to give them a task. If they need something they ask you one question at a time (up to 4), and your next message to them is the answer. When they finish they send a report card (summary, next steps, assumptions, full Markdown report), also saved under Reports. Every employee can take chat tasks (`assignment.work`). Without `ANTHROPIC_API_KEY` the task shows as blocked with a **Try again** button.
- **Office life** (Virtual office toggle, on by default, off with reduced motion): employees with no active work take decorative breaks in the pantry, restrooms and lounge, visit colleagues and greet each other in the corridors. Real work always interrupts a break; coloured bubbles are real work, emoji are breaks. "Needs you" marks someone waiting for your answer.

## What works today (no API keys required)

- **Lead intake** (manual or by agents) with duplicate prevention by domain or normalised name. Every lead and contact needs a source URL, and collected emails are stored as *unverified*.
- **Evidence-based scoring** from 0 to 100 with a breakdown for each criterion. Unevidenced claims are downgraded, and a score of 80+ requires at least 2 evidence items including one high-reliability source.
- **Routing**: 60+ goes to the Sales Director and is assigned to exactly **one** executive by specialisation and workload; 40–59 goes back to research; under 40 is marked low priority.
- **Single account ownership**, enforced in the database. If an owned company appears again, its owner is notified instead of a duplicate being created. Reassignment requires a reason and hands over the previous owner's memory.
- **18-stage pipeline** with guarded, recorded transitions:
  - Every active deal needs a next action with a due date.
  - "Contacted" requires a recorded interaction.
  - "Quotation Sent" requires an approved quotation.
  - "Won" requires evidence and a human approval.
  - AI employees cannot move deals backwards.
- **Human approvals** with role-based access for all external or commercial actions. A rejection sends feedback into an automatic redraft loop.
- **Manual outreach without AI**: write the message yourself on an opportunity; it goes through the same approval gate, then "Mark as sent" moves the deal to Contacted and schedules a follow-up.
- **Follow-ups**, a daily pipeline review with escalation, and daily and weekly reports and meetings generated from live data.
- **KPI plan**: a revenue target is reverse-calculated into required wins, quotations, RFQs and opportunities. Figures use historical rates when there is enough data, otherwise they are clearly labelled assumptions.
- **Technical RFQ analysis**: missing information, conflicts (for example prime > standby, or an ATS below full-load current), a 60 Hz caution, catalogue matching and a compliance matrix.
- **Per-executive sales dashboards**, an executive dashboard, a searchable internal message log, the audit log and the virtual office.

## Needs API keys or integrations

| Capability | Requires |
|---|---|
| Outreach and follow-up drafts, RFQ text extraction, lead discovery and research with cited web search, competitor research, content, marketing plan | `ANTHROPIC_API_KEY` |
| Market/trend research route | `XAI_API_KEY` |
| Duplicate check against Odoo partners | `ODOO_*` (adapter written, not yet verified against 4U's instance) |
| Automatic sending of approved emails | Gmail OAuth (interface only today: approved messages are sent manually, then marked as sent) |
| Marketing analytics | GA4, Search Console, Google Ads (interfaces only) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/MISSING_INPUTS.md](docs/MISSING_INPUTS.md) for what 4U needs to provide.
