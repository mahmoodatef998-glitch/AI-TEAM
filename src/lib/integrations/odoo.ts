/**
 * Odoo Community CRM adapter (JSON-RPC, `/jsonrpc` → `object.execute_kw`).
 *
 * Purpose: avoid duplicate CRM records — before creating a company, look it up in Odoo
 * (res.partner) by website domain and name, and link `companies.odoo_partner_id`.
 *
 * STATUS: implemented against the standard Odoo external API but NOT yet verified against
 * 4U's instance (URL, database, user and API key were not provided).
 */
export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  apiKey: string;
}

export function odooConfig(): OdooConfig | null {
  const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY } = process.env;
  if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY) return null;
  return { url: ODOO_URL.replace(/\/$/, ""), db: ODOO_DB, username: ODOO_USERNAME, apiKey: ODOO_API_KEY };
}

async function rpc<T>(cfg: OdooConfig, service: string, method: string, args: unknown[]): Promise<T> {
  const res = await fetch(`${cfg.url}/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
  });
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string; data?: { message?: string } } };
  if (body.error) throw new Error(`Odoo: ${body.error.data?.message ?? body.error.message}`);
  return body.result as T;
}

let uidCache: number | null = null;
async function uid(cfg: OdooConfig) {
  if (uidCache) return uidCache;
  const u = await rpc<number | false>(cfg, "common", "authenticate", [cfg.db, cfg.username, cfg.apiKey, {}]);
  if (!u) throw new Error("Odoo authentication failed");
  uidCache = u;
  return u;
}

async function executeKw<T>(cfg: OdooConfig, model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) {
  return rpc<T>(cfg, "object", "execute_kw", [cfg.db, await uid(cfg), cfg.apiKey, model, method, args, kwargs]);
}

export interface OdooPartner {
  id: number;
  name: string;
  website: string | false;
  email: string | false;
}

export async function findOdooPartner(name: string, domain: string | null): Promise<OdooPartner | null> {
  const cfg = odooConfig();
  if (!cfg) return null;
  const domainFilter = domain ? ["|", ["website", "ilike", domain], ["email", "ilike", `@${domain}`]] : [];
  const nameFilter = [["name", "ilike", name], ["is_company", "=", true]];
  const filter = domain ? ["|", "&", ...nameFilter, ...domainFilter] : nameFilter;
  const rows = await executeKw<OdooPartner[]>(cfg, "res.partner", "search_read", [filter], {
    fields: ["id", "name", "website", "email"],
    limit: 1,
  });
  return rows[0] ?? null;
}

export async function createOdooLead(values: { name: string; partnerId?: number | null; description?: string; expectedRevenue?: number | null }) {
  const cfg = odooConfig();
  if (!cfg) return null;
  return executeKw<number>(cfg, "crm.lead", "create", [
    {
      name: values.name,
      partner_id: values.partnerId ?? false,
      description: values.description ?? "",
      expected_revenue: values.expectedRevenue ?? 0,
      type: "opportunity",
    },
  ]);
}
