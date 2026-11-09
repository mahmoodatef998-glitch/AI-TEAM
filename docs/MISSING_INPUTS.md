# Inputs needed from 4U

The system runs without these items. Each missing one disables a specific capability, and the affected tasks show as **blocked** with the reason; nothing is replaced with guesses.

## Business data (highest impact)

1. **Monthly closed-revenue target.** Set it on the Executive dashboard. Until then the CGO's KPI plan is blocked.
2. **Approved product catalogue**, for each model:
   - engine brand and model, prime and standby kVA, frequency, voltage and phase, alternator, canopy, base-tank litres, maximum ambient rating;
   - **approved price** and availability / lead time;
   - the source document.

   Without it, RFQ matching and priced quotations are impossible.
3. **Quotation template**, payment terms, validity, warranty and standard exclusions.
4. **Historical sales data**: won and lost deals with values, dates and reasons. This replaces the initial planning assumptions:
   - average deal value AED 85,000;
   - 20% quote win rate;
   - 80% of RFQs quoted;
   - 25% of opportunities produce an RFQ.
5. **Sales Executive rules**: confirm or edit the specialisations in `src/lib/org/roster.ts`. Today:
   - Alex: complex projects of 1000 kVA or more;
   - Daniel: contractors and MEP firms;
   - Michael: industrial end users and resellers;
   - Sarah: key accounts.

   Also confirm their capacity limits and real monthly targets.
6. **Services scope**: maintenance and support offering, and the geographic coverage for installation and commissioning.
7. **Target markets and industries priority** (defaults: UAE first, then GCC, then export markets).

## Credentials and integrations

| Item | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | All drafting, research, RFQ text extraction |
| `XAI_API_KEY` (optional) | Grok research route |
| Odoo: URL, database, user, API key | Duplicate prevention against existing CRM partners; pushing opportunities |
| Gmail / Google Workspace OAuth client and refresh token for the sending mailbox | Automatic dispatch of approved emails, reply tracking |
| Search Console and GA4 (service account with read access) | SEO and marketing dashboard |
| Google Ads (developer token, customer ID, OAuth) | Paid-media analysis |
| `CRON_SECRET` and a scheduler (Vercel Cron or n8n) or a worker host | Schedules run while nobody has the dashboard open |

## Human approvers

Name the people who will hold these roles:

- `sales_manager`: approves outreach, quotations, discounts, delivery and technical commitments, and won deals.
- `marketing_manager`: approves campaigns, budgets and publishing.
- `admin`: approves price changes and agreements, and verifies knowledge and catalogue data.
