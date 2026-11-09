import { requireUser, WRITE_ROLES } from "@/lib/auth/session";
import { createLeadAction } from "@/app/actions";
import { ActionForm, Field, Submit } from "@/components/forms";
import { Card, PageHeader } from "@/components/ui";
import { ACCOUNT_TYPES, INDUSTRIES } from "@/lib/domain/taxonomy";

export default async function NewLeadPage() {
  await requireUser(WRITE_ROLES);
  return (
    <div className="max-w-4xl">
      <PageHeader title="Add lead" subtitle="Duplicates are detected automatically by website domain and company name. A source URL is required." />
      <ActionForm action={createLeadAction} className="space-y-6">
        <Card title="Company">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name *"><input name="companyName" required className="field" /></Field>
            <Field label="Website"><input name="website" type="url" placeholder="https://" className="field" /></Field>
            <Field label="Country"><input name="country" defaultValue="UAE" className="field" /></Field>
            <Field label="City"><input name="city" className="field" /></Field>
            <Field label="Industry">
              <select name="industry" className="field" defaultValue="">
                <option value="">Unknown</option>
                {Object.entries(INDUSTRIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Account type">
              <select name="accountType" className="field" defaultValue="">
                <option value="">Unknown</option>
                {ACCOUNT_TYPES.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}
              </select>
            </Field>
            <Field label="Company size">
              <select name="companySize" className="field" defaultValue="">
                <option value="">Unknown</option>
                {["small", "medium", "large", "enterprise"].map((k) => <option key={k}>{k}</option>)}
              </select>
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="companySizeVerified" /> Size verified from a source</label>
            <div className="sm:col-span-2"><Field label="Business activity"><input name="businessActivity" className="field" /></Field></div>
          </div>
        </Card>
        <Card title="Opportunity signal">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Potential requirement"><input name="requirementSummary" placeholder="e.g. 2 × 500 kVA standby for new warehouse" className="field" /></Field></div>
            <Field label="Capacity from (kVA)"><input name="capacityKvaMin" type="number" min="0" className="field" /></Field>
            <Field label="Capacity to (kVA)"><input name="capacityKvaMax" type="number" min="0" className="field" /></Field>
            <Field label="Signal strength">
              <select name="signalStrength" className="field" defaultValue="potential_requirement">
                <option value="confirmed_requirement">Confirmed requirement (inquiry / tender / RFQ)</option>
                <option value="strong_buying_signal">Strong buying signal (project / expansion)</option>
                <option value="potential_requirement">Potential requirement</option>
                <option value="speculative">Speculative</option>
              </select>
            </Field>
            <Field label="Purchase timing">
              <select name="purchaseTiming" className="field" defaultValue="unknown">
                <option value="immediate">Immediate</option><option value="within_3_months">Within 3 months</option><option value="within_12_months">Within 12 months</option><option value="unknown">Unknown</option>
              </select>
            </Field>
            <Field label="Buying signal"><input name="buyingSignal" className="field" /></Field>
            <Field label="Brand preference"><input name="brandPreference" className="field" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="hasActiveProject" /> Active project or expansion</label>
            <Field label="Lead source">
              <select name="source" className="field" defaultValue="manual_entry">
                {["manual_entry", "inbound_inquiry", "website_form", "tender_portal", "referral", "exhibition", "web_research"].map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
              </select>
            </Field>
            <Field label="Source URL" hint="Required unless the source is an inbound inquiry."><input name="sourceUrl" type="url" placeholder="https://" className="field" /></Field>
          </div>
        </Card>
        <Card title="Evidence (optional, strongly recommended)">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Evidence URL"><input name="evidenceUrl" type="url" className="field" /></Field>
            <Field label="Title"><input name="evidenceTitle" className="field" /></Field>
            <Field label="Type">
              <select name="evidenceType" className="field" defaultValue="project_announcement">
                {["project_announcement", "tender", "customer_inquiry", "company_website", "news", "directory", "linkedin", "other"].map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
              </select>
            </Field>
            <Field label="Reliability">
              <select name="evidenceReliability" className="field" defaultValue="medium"><option>high</option><option>medium</option><option>low</option></select>
            </Field>
            <div className="sm:col-span-2"><Field label="Excerpt"><textarea name="evidenceExcerpt" rows={2} className="field" /></Field></div>
          </div>
        </Card>
        <Card title="Contact (optional)">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><input name="contactName" className="field" /></Field>
            <Field label="Job title"><input name="contactTitle" className="field" /></Field>
            <Field label="Public business email"><input name="contactEmail" type="email" className="field" /></Field>
            <Field label="Public business phone"><input name="contactPhone" className="field" /></Field>
            <Field label="Where this contact was found (URL) *" hint="Required if you add a contact. Stored as unverified."><input name="contactSourceUrl" type="url" className="field" /></Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="contactIsDecisionMaker" /> Decision-maker</label>
          </div>
        </Card>
        <Submit>Create lead</Submit>
      </ActionForm>
    </div>
  );
}
