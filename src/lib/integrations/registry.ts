/**
 * Integration status registry — the single source of truth for what is connected.
 * Nothing in the system pretends an unconfigured integration works.
 */
export interface IntegrationStatus {
  key: string;
  name: string;
  configured: boolean;
  envVars: string[];
  unlocks: string;
  implementation: "implemented" | "interface_only";
  notes?: string;
}

const has = (...vars: string[]) => vars.every((v) => !!process.env[v]);

export function integrationStatuses(): IntegrationStatus[] {
  return [
    {
      key: "anthropic",
      name: "Claude (Anthropic API)",
      configured: has("ANTHROPIC_API_KEY"),
      envVars: ["ANTHROPIC_API_KEY"],
      unlocks: "Outreach drafting, RFQ extraction, lead discovery with cited web search, strategy & analysis narratives",
      implementation: "implemented",
    },
    {
      key: "xai",
      name: "Grok (xAI API via Vercel AI SDK)",
      configured: has("XAI_API_KEY"),
      envVars: ["XAI_API_KEY"],
      unlocks: "Market and trend research route (research_realtime profile)",
      implementation: "implemented",
    },
    {
      key: "odoo",
      name: "Odoo Community CRM",
      configured: has("ODOO_URL", "ODOO_DB", "ODOO_USERNAME", "ODOO_API_KEY"),
      envVars: ["ODOO_URL", "ODOO_DB", "ODOO_USERNAME", "ODOO_API_KEY"],
      unlocks: "Duplicate check against existing Odoo partners; pushing won/active opportunities to Odoo",
      implementation: "implemented",
      notes: "JSON-RPC adapter written to the standard Odoo external API; not yet verified against 4U's instance.",
    },
    {
      key: "email",
      name: "Business email (Gmail / Google Workspace)",
      configured: false,
      envVars: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_SENDER"],
      unlocks: "Automatic dispatch of APPROVED emails and inbound reply tracking",
      implementation: "interface_only",
      notes: "Approved emails are currently marked 'manual required' and confirmed with 'Mark as sent'.",
    },
    {
      key: "gsc",
      name: "Google Search Console",
      configured: false,
      envVars: ["GOOGLE_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL"],
      unlocks: "SEO Specialist: real rankings, queries, CTR",
      implementation: "interface_only",
    },
    {
      key: "ga4",
      name: "Google Analytics 4",
      configured: false,
      envVars: ["GOOGLE_SERVICE_ACCOUNT_JSON", "GA4_PROPERTY_ID"],
      unlocks: "Marketing dashboard: visitors, organic traffic, conversions",
      implementation: "interface_only",
    },
    {
      key: "google_ads",
      name: "Google Ads",
      configured: false,
      envVars: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_REFRESH_TOKEN"],
      unlocks: "Performance Marketing Specialist: spend, CPC, wasted spend, negative keywords",
      implementation: "interface_only",
    },
    {
      key: "linkedin",
      name: "LinkedIn",
      configured: false,
      envVars: [],
      unlocks: "No permitted API for prospect messaging; LinkedIn messages are drafted, approved, then sent manually.",
      implementation: "interface_only",
    },
    {
      key: "n8n",
      name: "n8n / external scheduler",
      configured: has("CRON_SECRET"),
      envVars: ["CRON_SECRET"],
      unlocks: "POST /api/cron/tick — run the scheduler and agent queue from n8n, Vercel Cron or any scheduler",
      implementation: "implemented",
    },
  ];
}
