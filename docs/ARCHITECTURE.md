# Architecture

## 1. Overview

```
 Browser (Next.js App Router UI, PixiJS office)
        │ server components / server actions (RBAC checked on every action)
        ▼
 Domain layer  src/lib/domain/*   ← single source of business rules (pure TS + SQL)
        │
        ├── PostgreSQL (Drizzle ORM)   all state, audit log, queue, schedules
        │
 Agent runtime src/lib/agents/*
   scheduler (cron, Asia/Dubai) → tasks table (queue) → worker/tick → executor → skill
                                                                         │
                                         model router (src/lib/ai/router.ts)
                                         ├─ Anthropic SDK (Claude, web search, structured output)
                                         └─ Vercel AI SDK (Grok)
 Integrations src/lib/integrations/*  (Odoo JSON-RPC, email interface, status registry)
```

- **Domain first.** UI actions, agent skills and tests all call the same domain functions, so a business rule such as "one owner per account" is enforced in exactly one place, and the database backs it with a unique or primary key.
- **Agents are tasks with skills.** An AI employee is a database row with a role, permitted `skills`, a persona, a specialisation, targets and memory. The employee's work is the `tasks` assigned to them. The executor refuses any task type that is not in the assignee's skills.
- **Deterministic where possible, LLM where needed.** Scoring, routing, pipeline control, KPI maths, RFQ engineering checks, reporting and the SEO crawl are deterministic code. Only language work (drafting, extraction, web research) calls a model, so the core keeps working without API keys.

## 2. AI employees

| Code | Employee | Department | Skills (task types) |
|---|---|---|---|
| E01 | Nadia, Chief Growth Officer | Executive | `kpi.plan`, `briefing.daily`, `meeting.weekly_exec` |
| E02 | Rami, Sales Director | Sales | `lead.assign`, `pipeline.review`, `meeting.sales_review` |
| S01–S04 | Alex, Daniel, Michael, Sarah, Sales Executives | Sales | `opportunity.onboard`, `outreach.draft`, `followup.prepare` |
| E05 | Hassan, Lead Research Manager | Lead Gen | `lead.research` |
| E06 | Lina, Lead Generation Specialist | Lead Gen | `lead.discover` |
| E07 | Omar, Lead Qualification Specialist | Lead Gen | `lead.qualify` |
| E08 | Layla, Marketing Director | Marketing | `marketing.plan` |
| E09 | Yusuf, SEO Specialist | Marketing | `seo.audit` |
| E10 | Maya, Content Creator | Marketing | `content.draft` |
| E11 | Karim, Performance Marketing | Marketing | `ads.review` |
| E12 | Tariq, Market Intelligence | Research | `competitor.research` |
| E13 | Huda, Business Analyst | Research | `report.daily_performance` |
| E14 | Faris, Technical Generator Sales Assistant | Technical Sales | `rfq.analyze` |

Names, personas, specialisations and targets are configuration (`src/lib/org/roster.ts`). To add or remove an employee, add a roster entry and re-run `npm run db:seed`.

## 3. Data model (`src/lib/db/schema.ts`)

| Area | Tables |
|---|---|
| Identity | `users` (roles: admin, sales_manager, sales_user, marketing_manager, viewer), `sessions` (only the SHA-256 of the token is stored) |
| Organisation | `departments`, `ai_employees`, `agent_memories` |
| Knowledge | `knowledge_items` (verified flag), `products` (approved catalogue, verified-price flag) |
| CRM | `companies` (unique domain; unique normalised name + country), `contacts` (source URL required, email verification status), `leads` (one open lead per company), `lead_evidence` |
| Ownership | `account_owners` (company ID is the primary key, so one owner per account), `ownership_history` |
| Pipeline | `opportunities` (one per lead), `stage_transitions`, `interactions`, `follow_ups`, `rfqs`, `quotations` |
| Work | `tasks` (queue with dedupe key, attempts, locks), `messages` (full-text index), `meetings`, `approvals` |
| Business | `business_targets`, `reports`, `campaigns`, `metric_snapshots` (`is_estimate` and `source` columns) |
| Operations | `activity_log` (append-only audit trail and office feed), `schedules`, `model_routes`, `ai_usage` (tokens, cost, latency) |

## 4. Agent execution

1. **Enqueue.** `createTask` is idempotent on `dedupe_key` (enforced by a partial unique index over active statuses).
2. **Claim.** `claimNextTask` uses `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`. Priority comes first, and no employee runs two tasks at once.
3. **Execute.** The executor sets the employee's office status and location from the skill, runs it, and maps the result:
   - `completed`: the employee returns to their desk.
   - `blocked`: a missing key, data or integration, recorded with the reason.
   - `waiting_approval`: the employee moves to the waiting area.
   - error: retried with exponential backoff (1, 4, 16 minutes) up to `max_attempts`.

   Stale locks (more than 10 minutes) are recovered.
4. **Schedule.** `runScheduler` enqueues each cron slot exactly once (`schedule:<key>:<slot>`) with a 3-hour catch-up window.
5. **Run.** `tick()` runs from `npm run worker`, from `POST /api/cron/tick`, or after UI actions via Next's `after()`.

## 5. Collaboration and memory

- Every hand-off is a stored message: `task_assignment`, `research_share`, `information_request`, `escalation`, `report`, `acknowledgement` and others. Examples: qualifier to director, director to executive, executive acknowledging, executive asking research for a decision-maker, director escalating to the CGO.
- Executives read memory with `recall()` before drafting. Assignments, account plans and approver feedback are written back with `remember()`. When an account is reassigned, its memories are copied to the new owner.

## 6. Lead lifecycle

```
discover/manual intake ─▶ dedupe ─▶ lead.qualify ──≥60──▶ lead.assign ─▶ account_owners + opportunity(qualified)
      (source URL req.)                │   40–59 ─▶ lead.research ─▶ re-qualify
                                       └   <40  ─▶ low_priority
opportunity.onboard ─▶ (no decision-maker? request research) ─▶ outreach.draft ─▶ approval ─▶ sent ─▶ contacted ─▶ follow-ups …
```

**Anti-fabrication for web research.** Discovery and research call Claude with the server-side web search tool, then convert the report into a schema. Any evidence or contact URL that the search tool did not actually return is discarded before intake.

**Assignment.** The router scores each executive and picks the highest:

| Factor | Points |
|---|---|
| Account-type match | +40 |
| Industry match | +30 |
| Complex or high-capacity project (≥1000 kVA, synchronisation, multiple units) | +35 |
| Workload | up to −30 |
| Each overdue follow-up | −3 |

Executives already at capacity are excluded unless every executive is at capacity. An existing account owner always keeps the account.

## 7. Pipeline guards (`validateTransition`)

- Won is final. Only a human can reopen a lost or disqualified opportunity.
- AI employees cannot move a deal backwards, except back into Follow-up.
- Contacted and every later stage need a sent, received or logged interaction.
- Quotation Sent needs a quotation with status approved or sent.
- Won needs evidence plus an approved `mark_deal_won` approval.
- Lost and Disqualified need a reason.
- Every active stage needs a next action with a due date.

Closing an opportunity cancels its pending follow-ups.

## 8. Approvals (`APPROVAL_POLICY`)

| Actions | Who can decide |
|---|---|
| Send email or LinkedIn message, send quotation, offer discount, confirm delivery date, technical commitment, mark won | admin, sales_manager |
| Launch or budget ads, publish content | admin, marketing_manager |
| Change price, sign agreement | admin |

- A rejection requires a note, which goes into a redraft task for the same employee.
- When an action is approved but no integration is connected, it is marked `manual_required`. A human sends it and then clicks **Mark as sent**, which moves the deal to Contacted and schedules a follow-up.
- Every decision is logged.

## 9. Security

- Secrets live only in server environment variables and are never sent to the client.
- Passwords are hashed with scrypt. Session cookies are httpOnly and SameSite=Lax.
- Every page and server action checks the user's role.
- The cron endpoint is protected by a constant-time comparison of a bearer secret.
- There is a complete audit trail.

## 10. Phase status

| Phase | Status |
|---|---|
| 1 Core foundation | Done: schema, auth/RBAC, dashboard, employees, departments, tasks, messages, activity log |
| 2 Sales department | Done: director, 4 executives, assignment, ownership, CRM, pipeline, follow-ups, dashboards |
| 3 Lead generation | Done: deterministic parts (intake, dedupe, scoring, routing). Discovery and research need `ANTHROPIC_API_KEY` |
| 4 Marketing | Partial: SEO crawl (deterministic), content/plan/competitor skills (LLM). Analytics need GA4, GSC and Ads |
| 5 Technical sales | Partial: RFQ analysis and compliance matrix. Priced quotation drafts need the catalogue and template |
| 6 Virtual office | Done (2D PixiJS), driven by real state |
| 7 Automation | Partial: schedules, daily and weekly reports and meetings. Optimisation loops depend on real history |
