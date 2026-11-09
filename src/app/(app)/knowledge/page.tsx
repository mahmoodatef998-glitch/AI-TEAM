import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { knowledgeItems, products } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { addKnowledgeAction, addProductAction, verifyKnowledgeAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { Badge, Card, Empty, fmtAed, fmtDate, humanize, PageHeader, Table, Td } from "@/components/ui";

const CATS = ["company_profile", "product_catalogue", "pricing", "policy", "template", "technical", "competitor", "marketing"];

export default async function KnowledgePage() {
  const user = await requireUser();
  const db = getDb();
  const items = await db.select().from(knowledgeItems).orderBy(desc(knowledgeItems.updatedAt));
  const prods = await db.select().from(products).orderBy(products.brand, products.primeKva);
  const canAdd = ["admin", "sales_manager", "marketing_manager"].includes(user.role);
  return (
    <div className="space-y-6">
      <PageHeader title="Knowledge base & approved catalogue" subtitle="AI employees may state only VERIFIED facts externally. Only administrators can verify." />
      <Card title={`Knowledge items (${items.length})`}>
        {items.length === 0 ? <Empty title="No knowledge items" /> : (
          <ul className="space-y-3">
            {items.map((k) => (
              <li key={k.id} className="flex flex-wrap items-start justify-between gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{k.title}</span><Badge>{humanize(k.category)}</Badge><Badge tone={k.verified ? "green" : "amber"}>{k.verified ? "verified" : "unverified"}</Badge></div>
                  <p className="mt-0.5">{k.content}</p>
                  <div className="text-xs text-muted">Source: {k.source} · updated {fmtDate(k.updatedAt)}</div>
                </div>
                {user.role === "admin" && <form action={verifyKnowledgeAction.bind(null, k.id, !k.verified)}><button className="btn-secondary">{k.verified ? "Unverify" : "Verify"}</button></form>}
              </li>
            ))}
          </ul>
        )}
        {canAdd && (
          <ActionForm action={addKnowledgeAction} className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <Field label="Category"><select name="category" className="field">{CATS.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
            <Field label="Title"><input name="title" required className="field" /></Field>
            <div className="sm:col-span-2"><Field label="Content"><textarea name="content" rows={3} required className="field" /></Field></div>
            <Field label="Source (document / person / URL)"><input name="source" required className="field" /></Field>
            {user.role === "admin" && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="verified" /> Mark as verified</label>}
            <div><Submit>Add knowledge</Submit></div>
          </ActionForm>
        )}
      </Card>
      <Card title={`Approved product catalogue (${prods.length})`}>
        {prods.length === 0 ? (
          <Empty title="Catalogue is empty">The Technical Sales Assistant cannot match RFQs to products or prepare priced quotations until 4U&apos;s verified catalogue is loaded. Nothing is guessed.</Empty>
        ) : (
          <Table head={["Brand / model", "Prime", "Standby", "Hz / V / phase", "Canopy", "Price", "Availability", "Source"]}>
            {prods.map((p) => <tr key={p.id}><Td className="font-medium">{p.brand} {p.model}</Td><Td>{p.primeKva ?? "—"} kVA</Td><Td>{p.standbyKva ?? "—"} kVA</Td><Td className="text-xs">{p.frequencyHz ?? "?"} Hz · {p.voltage ?? "?"} · {p.phase ?? "?"}ph</Td><Td>{p.canopy ?? "—"}</Td><Td>{fmtAed(p.priceAed)} {p.priceAed && <Badge tone={p.priceVerified ? "green" : "amber"}>{p.priceVerified ? "verified" : "unverified"}</Badge>}</Td><Td>{p.availability}</Td><Td className="text-xs text-muted">{p.source}</Td></tr>)}
          </Table>
        )}
        {user.role === "admin" && (
          <ActionForm action={addProductAction} className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-4">
            {[["brand", "Engine brand *"], ["model", "Model *"], ["sku", "SKU"], ["engineModel", "Engine model"], ["primeKva", "Prime kVA"], ["standbyKva", "Standby kVA"], ["frequencyHz", "Frequency Hz"], ["voltage", "Voltage"], ["phase", "Phase"], ["alternator", "Alternator"], ["fuelTankLiters", "Base tank (L)"], ["canopy", "Canopy"], ["maxAmbientC", "Max ambient °C"], ["priceAed", "Price AED"], ["availability", "Availability"], ["source", "Source document *"]].map(([n, l]) => <Field key={n} label={l}><input name={n} className="field" /></Field>)}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="priceVerified" /> Price approved</label>
            <div className="sm:col-span-3"><Submit>Add product</Submit></div>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
