/**
 * 4U AI Workforce — PostgreSQL schema (Drizzle ORM).
 *
 * Design principles encoded here:
 *  - Every lead has a traceable source (lead_evidence, leads.source).
 *  - Every account has exactly ONE owner (account_owners.company_id is UNIQUE).
 *  - Every pipeline transition is recorded (stage_transitions).
 *  - Every external action goes through approvals.
 *  - Every actor action is written to activity_log (audit trail + virtual office feed).
 *  - Estimates are always flagged (is_estimate / value_is_estimate columns).
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  real,
  date,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

// ───────────────────────────── enums ─────────────────────────────

export const userRole = pgEnum("user_role", [
  "admin", // full control, approves everything
  "sales_manager", // approves sales communication, quotations, reassignment
  "sales_user", // views sales, logs interactions
  "marketing_manager", // approves marketing content/campaigns
  "viewer", // read-only
]);

export const employeeStatus = pgEnum("employee_status", [
  "idle",
  "working",
  "researching",
  "writing",
  "analyzing",
  "contacting_customer",
  "preparing_quotation",
  "in_meeting",
  "waiting_approval",
  "blocked",
  "error",
]);

export const officeLocation = pgEnum("office_location", [
  "desk",
  "executive_office",
  "sales_department",
  "marketing_department",
  "lead_generation_department",
  "research_department",
  "meeting_room",
  "operations_room",
  "waiting_area",
]);

export const taskStatus = pgEnum("task_status", [
  "queued",
  "running",
  "waiting_approval",
  "blocked", // cannot run: missing integration / data / credentials
  "completed",
  "failed",
  "cancelled",
]);

export const leadStatus = pgEnum("lead_status", [
  "new",
  "researching",
  "needs_more_research",
  "qualified",
  "low_priority",
  "assigned",
  "rejected",
  "duplicate",
]);

export const signalStrength = pgEnum("signal_strength", [
  "confirmed_requirement",
  "strong_buying_signal",
  "potential_requirement",
  "speculative",
]);

export const leadPriority = pgEnum("lead_priority", [
  "high_priority",
  "qualified",
  "needs_more_research",
  "low_priority",
]);

export const pipelineStage = pgEnum("pipeline_stage", [
  "new_lead",
  "researching",
  "contact_identified",
  "qualified",
  "initial_contact_drafted",
  "awaiting_approval",
  "contacted",
  "interested",
  "rfq_received",
  "technical_evaluation",
  "quotation_preparation",
  "quotation_sent",
  "follow_up",
  "negotiation",
  "verbal_approval",
  "won",
  "lost",
  "disqualified",
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

export const approvalAction = pgEnum("approval_action", [
  "send_external_email",
  "send_linkedin_message",
  "launch_ad_campaign",
  "publish_content",
  "change_ad_budget",
  "send_quotation",
  "change_product_price",
  "offer_discount",
  "confirm_delivery_date",
  "technical_commitment",
  "sign_agreement",
  "mark_deal_won",
]);

export const actorType = pgEnum("actor_type", ["user", "agent", "system"]);

export const messageKind = pgEnum("message_kind", [
  "message",
  "task_assignment",
  "information_request",
  "research_share",
  "escalation",
  "approval_request",
  "report",
  "acknowledgement",
]);

export const followUpStatus = pgEnum("follow_up_status", [
  "pending",
  "done",
  "missed",
  "cancelled",
]);

export const emailVerification = pgEnum("email_verification", [
  "unverified",
  "verified",
  "invalid",
]);

// ─────────────────────────── identity ───────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("viewer"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the cookie token — raw token never stored
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ─────────────────────── organization / agents ───────────────────────

export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  officeZone: officeLocation("office_zone").notNull(),
  kpis: jsonb("kpis").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
});

export type EmployeeTargets = {
  weekly?: Record<string, number>;
  monthly?: Record<string, number>;
  /** true when the target is an initial assumption, not management-set */
  isAssumption?: boolean;
};

export type EmployeeSpecialization = {
  industries?: string[];
  accountTypes?: string[]; // e.g. "key_account", "contractor", "reseller", "end_user"
  minDealAed?: number;
  maxOpenOpportunities?: number;
  notes?: string;
};

export const aiEmployees = pgTable(
  "ai_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(), // E01..E14
    roleKey: text("role_key").notNull().unique(), // e.g. cgo, sales_director, sales_exec_alex
    name: text("name").notNull(),
    title: text("title").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id),
    managerId: uuid("manager_id"),
    persona: text("persona").notNull(),
    jobDescription: text("job_description").notNull(),
    responsibilities: jsonb("responsibilities").$type<string[]>().notNull().default([]),
    skills: jsonb("skills").$type<string[]>().notNull().default([]), // task types this employee can run
    specialization: jsonb("specialization").$type<EmployeeSpecialization>().notNull().default({}),
    targets: jsonb("targets").$type<EmployeeTargets>().notNull().default({}),
    isSalesExecutive: boolean("is_sales_executive").notNull().default(false),
    status: employeeStatus("status").notNull().default("idle"),
    location: officeLocation("location").notNull().default("desk"),
    currentTaskId: uuid("current_task_id"),
    statusDetail: text("status_detail"),
    avatarColor: text("avatar_color").notNull().default("#3b82f6"),
    active: boolean("active").notNull().default(true),
    lastActiveAt: ts("last_active_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_employees_dept_idx").on(t.departmentId)],
);

export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => aiEmployees.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // customer_preference | objection | promise | conversation | fact | lesson
    subjectType: text("subject_type"), // company | opportunity | lead | null
    subjectId: uuid("subject_id"),
    content: text("content").notNull(),
    importance: integer("importance").notNull().default(3), // 1..5
    sourceTaskId: uuid("source_task_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_memories_emp_idx").on(t.employeeId),
    index("agent_memories_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

// ─────────────────────────── knowledge ───────────────────────────

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: text("category").notNull(), // company_profile | product_catalogue | pricing | policy | template | competitor | marketing | technical
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: text("source").notNull(),
    verified: boolean("verified").notNull().default(false),
    verifiedByUserId: uuid("verified_by_user_id").references(() => users.id),
    verifiedAt: ts("verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("knowledge_category_idx").on(t.category)],
);

/** Approved product catalogue. Empty until 4U provides verified data. */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").unique(),
    brand: text("brand").notNull(), // engine brand: Perkins, Cummins, Volvo...
    model: text("model").notNull(),
    primeKva: real("prime_kva"),
    standbyKva: real("standby_kva"),
    frequencyHz: integer("frequency_hz"), // 50 | 60
    voltage: text("voltage"), // e.g. "400/230"
    phase: integer("phase"), // 1 | 3
    engineModel: text("engine_model"),
    alternator: text("alternator"),
    fuelTankLiters: real("fuel_tank_liters"),
    canopy: text("canopy"), // open | soundproof
    fuelConsumptionLph75: real("fuel_consumption_lph_75"),
    maxAmbientC: real("max_ambient_c"),
    priceAed: numeric("price_aed", { precision: 14, scale: 2 }),
    priceVerified: boolean("price_verified").notNull().default(false),
    availability: text("availability"), // in_stock | made_to_order | unknown
    leadTimeWeeks: real("lead_time_weeks"),
    source: text("source").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("products_kva_idx").on(t.primeKva)],
);

// ───────────────────────────── CRM ─────────────────────────────

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    domain: text("domain"), // normalized registrable domain, e.g. "abc.ae"
    website: text("website"),
    country: text("country"),
    city: text("city"),
    industry: text("industry"),
    businessActivity: text("business_activity"),
    companySize: text("company_size"), // small | medium | large | enterprise — only if verifiable
    companySizeVerified: boolean("company_size_verified").notNull().default(false),
    linkedinUrl: text("linkedin_url"),
    accountType: text("account_type"), // end_user | contractor | reseller | consultant | key_account
    odooPartnerId: integer("odoo_partner_id"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Duplicate prevention: one company per domain and per normalized name+country.
    uniqueIndex("companies_domain_uq").on(t.domain).where(sql`${t.domain} is not null`),
    uniqueIndex("companies_name_country_uq").on(t.normalizedName, sql`coalesce(${t.country}, '')`),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name"),
    jobTitle: text("job_title"),
    isDecisionMaker: boolean("is_decision_maker").notNull().default(false),
    email: text("email"),
    emailStatus: emailVerification("email_status").notNull().default("unverified"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    sourceUrl: text("source_url").notNull(), // every contact detail must be traceable
    collectedAt: ts("collected_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("contacts_company_idx").on(t.companyId)],
);

export type ScoreBreakdown = {
  criterion: string;
  points: number;
  max: number;
  reason: string;
}[];

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    status: leadStatus("status").notNull().default("new"),
    requirementSummary: text("requirement_summary"),
    capacityKvaMin: real("capacity_kva_min"),
    capacityKvaMax: real("capacity_kva_max"),
    brandPreference: text("brand_preference"),
    signalStrength: signalStrength("signal_strength").notNull().default("speculative"),
    buyingSignal: text("buying_signal"),
    hasActiveProject: boolean("has_active_project").notNull().default(false),
    purchaseTiming: text("purchase_timing"), // immediate | within_3_months | within_12_months | unknown
    score: integer("score"),
    priority: leadPriority("priority"),
    scoreBreakdown: jsonb("score_breakdown").$type<ScoreBreakdown>(),
    scoredAt: ts("scored_at"),
    recommendedApproach: text("recommended_approach"),
    source: text("source").notNull(), // e.g. "tender_portal", "google_search", "manual_entry", "website_form"
    sourceUrl: text("source_url"),
    discoveredByEmployeeId: uuid("discovered_by_employee_id").references(() => aiEmployees.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    duplicateOfLeadId: uuid("duplicate_of_lead_id"),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("leads_status_idx").on(t.status),
    // At most one open lead per company (closed = assigned/rejected/duplicate keep history).
    uniqueIndex("leads_company_open_uq")
      .on(t.companyId)
      .where(sql`${t.status} not in ('rejected', 'duplicate', 'assigned')`),
  ],
);

export const leadEvidence = pgTable(
  "lead_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    evidenceType: text("evidence_type").notNull(), // project_announcement | tender | company_website | news | directory | linkedin | customer_inquiry | other
    url: text("url").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    publishedAt: date("published_at"),
    reliability: text("reliability").notNull().default("medium"), // high | medium | low
    collectedAt: ts("collected_at").notNull().defaultNow(),
    collectedByEmployeeId: uuid("collected_by_employee_id").references(() => aiEmployees.id),
    collectedByUserId: uuid("collected_by_user_id").references(() => users.id),
  },
  (t) => [index("lead_evidence_lead_idx").on(t.leadId)],
);

/** One primary owner per account. UNIQUE(company_id) enforces the ownership rule at the DB level. */
export const accountOwners = pgTable("account_owners", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id),
  ownerEmployeeId: uuid("owner_employee_id")
    .notNull()
    .references(() => aiEmployees.id),
  assignedAt: ts("assigned_at").notNull().defaultNow(),
  assignedByEmployeeId: uuid("assigned_by_employee_id").references(() => aiEmployees.id),
  assignedByUserId: uuid("assigned_by_user_id").references(() => users.id),
  reason: text("reason").notNull(),
});

export const ownershipHistory = pgTable(
  "ownership_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    fromEmployeeId: uuid("from_employee_id").references(() => aiEmployees.id),
    toEmployeeId: uuid("to_employee_id")
      .notNull()
      .references(() => aiEmployees.id),
    reason: text("reason").notNull(),
    changedByType: actorType("changed_by_type").notNull(),
    changedById: uuid("changed_by_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ownership_history_company_idx").on(t.companyId)],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    leadId: uuid("lead_id").references(() => leads.id),
    ownerEmployeeId: uuid("owner_employee_id")
      .notNull()
      .references(() => aiEmployees.id),
    title: text("title").notNull(),
    stage: pipelineStage("stage").notNull().default("new_lead"),
    capacityKva: real("capacity_kva"),
    brandPreference: text("brand_preference"),
    expectedValueAed: numeric("expected_value_aed", { precision: 14, scale: 2 }),
    valueIsEstimate: boolean("value_is_estimate").notNull().default(true),
    probability: integer("probability"), // 0..100
    expectedCloseDate: date("expected_close_date"),
    nextAction: text("next_action"),
    nextActionDue: ts("next_action_due"),
    lostReason: text("lost_reason"),
    disqualifiedReason: text("disqualified_reason"),
    wonEvidence: text("won_evidence"),
    actualValueAed: numeric("actual_value_aed", { precision: 14, scale: 2 }),
    grossMarginAed: numeric("gross_margin_aed", { precision: 14, scale: 2 }),
    odooLeadId: integer("odoo_lead_id"),
    lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("opportunities_owner_idx").on(t.ownerEmployeeId),
    index("opportunities_stage_idx").on(t.stage),
    // A lead converts into at most one opportunity.
    uniqueIndex("opportunities_lead_uq").on(t.leadId).where(sql`${t.leadId} is not null`),
  ],
);

export const stageTransitions = pgTable(
  "stage_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    fromStage: pipelineStage("from_stage"),
    toStage: pipelineStage("to_stage").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("stage_transitions_opp_idx").on(t.opportunityId)],
);

export const interactions = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    employeeId: uuid("employee_id").references(() => aiEmployees.id),
    userId: uuid("user_id").references(() => users.id),
    channel: text("channel").notNull(), // email | linkedin | phone | meeting | note | rfq | quotation
    direction: text("direction").notNull(), // outbound | inbound | internal
    status: text("status").notNull(), // draft | pending_approval | approved | sent | received | logged | rejected
    subject: text("subject"),
    body: text("body"),
    approvalId: uuid("approval_id"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("interactions_opp_idx").on(t.opportunityId),
    index("interactions_company_idx").on(t.companyId),
  ],
);

export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    ownerEmployeeId: uuid("owner_employee_id")
      .notNull()
      .references(() => aiEmployees.id),
    dueAt: ts("due_at").notNull(),
    purpose: text("purpose").notNull(),
    status: followUpStatus("status").notNull().default("pending"),
    completedAt: ts("completed_at"),
    outcome: text("outcome"),
    createdAt: createdAt(),
  },
  (t) => [
    index("follow_ups_owner_due_idx").on(t.ownerEmployeeId, t.dueAt),
    index("follow_ups_opp_idx").on(t.opportunityId),
  ],
);

export type RfqRequirement = {
  quantity?: number | null;
  primeKva?: number | null;
  standbyKva?: number | null;
  frequencyHz?: number | null;
  voltage?: string | null;
  phase?: number | null;
  brandPreference?: string | null;
  canopy?: string | null;
  fuelTankHours?: number | null;
  fuelTankLiters?: number | null;
  ats?: boolean | null;
  atsRatingA?: number | null;
  synchronization?: boolean | null;
  ambientTempC?: number | null;
  application?: string | null;
  deliveryLocation?: string | null;
  requiredDelivery?: string | null;
  installationRequired?: boolean | null;
  loadBankTest?: boolean | null;
  notes?: string | null;
};

export const rfqs = pgTable(
  "rfqs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    receivedAt: ts("received_at").notNull().defaultNow(),
    rawText: text("raw_text"),
    requirements: jsonb("requirements").$type<RfqRequirement>(),
    extractionMethod: text("extraction_method"), // manual | llm
    missingInfo: jsonb("missing_info").$type<string[]>(),
    conflicts: jsonb("conflicts").$type<string[]>(),
    complianceMatrix: jsonb("compliance_matrix"),
    customerQuestions: jsonb("customer_questions").$type<string[]>(),
    status: text("status").notNull().default("received"), // received | analyzed | awaiting_customer_info | ready_for_quotation
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("rfqs_opp_idx").on(t.opportunityId)],
);

export const quotations = pgTable(
  "quotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    rfqId: uuid("rfq_id").references(() => rfqs.id),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"), // draft | pending_approval | approved | sent | superseded | rejected
    currency: text("currency").notNull().default("AED"),
    lines: jsonb("lines").$type<Array<{ productId?: string; description: string; qty: number; unitPriceAed?: number | null; priceVerified: boolean }>>().notNull().default([]),
    totalAed: numeric("total_aed", { precision: 14, scale: 2 }),
    validityDays: integer("validity_days"),
    approvalId: uuid("approval_id"),
    sentAt: ts("sent_at"),
    createdByEmployeeId: uuid("created_by_employee_id").references(() => aiEmployees.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("quotations_opp_idx").on(t.opportunityId)],
);

// ───────────────────────── work management ─────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(), // skill key, e.g. "lead.qualify"
    title: text("title").notNull(),
    description: text("description"),
    assigneeEmployeeId: uuid("assignee_employee_id")
      .notNull()
      .references(() => aiEmployees.id),
    createdByType: actorType("created_by_type").notNull(),
    createdById: uuid("created_by_id"),
    parentTaskId: uuid("parent_task_id"),
    relatedType: text("related_type"), // lead | opportunity | company | report | campaign
    relatedId: uuid("related_id"),
    status: taskStatus("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(5), // 1 (low) .. 10 (urgent)
    progress: integer("progress").notNull().default(0), // 0..100
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown>>(),
    blockedReason: text("blocked_reason"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: ts("run_after").notNull().defaultNow(),
    dedupeKey: text("dedupe_key"),
    lockedBy: text("locked_by"),
    lockedAt: ts("locked_at"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_queue_idx").on(t.status, t.runAfter, t.priority),
    index("tasks_assignee_idx").on(t.assigneeEmployeeId, t.status),
    index("tasks_related_idx").on(t.relatedType, t.relatedId),
    // Idempotency: the same logical job cannot be queued twice while active.
    uniqueIndex("tasks_dedupe_active_uq")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} in ('queued', 'running', 'waiting_approval', 'blocked')`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id"),
    kind: messageKind("kind").notNull().default("message"),
    fromEmployeeId: uuid("from_employee_id").references(() => aiEmployees.id),
    fromUserId: uuid("from_user_id").references(() => users.id),
    toEmployeeId: uuid("to_employee_id").references(() => aiEmployees.id),
    toUserId: uuid("to_user_id").references(() => users.id),
    subject: text("subject"),
    body: text("body").notNull(),
    relatedType: text("related_type"),
    relatedId: uuid("related_id"),
    taskId: uuid("task_id"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_to_idx").on(t.toEmployeeId, t.createdAt),
    index("messages_from_idx").on(t.fromEmployeeId, t.createdAt),
    index("messages_search_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${t.subject}, '') || ' ' || ${t.body})`,
    ),
  ],
);

export const meetings = pgTable("meetings", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // daily_briefing | weekly_exec | sales_review | marketing_review | lead_quality_review
  title: text("title").notNull(),
  status: text("status").notNull().default("scheduled"), // scheduled | in_progress | completed
  scheduledFor: ts("scheduled_for").notNull(),
  attendeeEmployeeIds: jsonb("attendee_employee_ids").$type<string[]>().notNull().default([]),
  agenda: jsonb("agenda").$type<string[]>().notNull().default([]),
  minutes: text("minutes"),
  taskId: uuid("task_id"),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
  createdAt: createdAt(),
});

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: approvalAction("action").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    requestedByEmployeeId: uuid("requested_by_employee_id").references(() => aiEmployees.id),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    taskId: uuid("task_id"),
    relatedType: text("related_type"),
    relatedId: uuid("related_id"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    executionStatus: text("execution_status"), // null | executed | manual_required | failed
    executionDetail: text("execution_detail"),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_status_idx").on(t.status, t.createdAt)],
);

// ─────────────────────────── marketing ───────────────────────────

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  channel: text("channel").notNull(), // google_ads | meta | linkedin | email | seo | content
  status: text("status").notNull().default("draft"), // draft | pending_approval | active | paused | completed
  objective: text("objective"),
  targetIndustries: jsonb("target_industries").$type<string[]>().notNull().default([]),
  proposedBudgetAed: numeric("proposed_budget_aed", { precision: 14, scale: 2 }),
  actualSpendAed: numeric("actual_spend_aed", { precision: 14, scale: 2 }),
  ownerEmployeeId: uuid("owner_employee_id").references(() => aiEmployees.id),
  externalId: text("external_id"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(), // company | department | employee | campaign | channel
    scopeId: text("scope_id"),
    metric: text("metric").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    value: numeric("value", { precision: 18, scale: 4 }).notNull(),
    isEstimate: boolean("is_estimate").notNull().default(false),
    source: text("source").notNull(), // internal_db | ga4 | gsc | google_ads | manual | assumption
    createdAt: createdAt(),
  },
  (t) => [index("metric_snapshots_lookup_idx").on(t.scope, t.scopeId, t.metric, t.periodStart)],
);

export const businessTargets = pgTable("business_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  period: text("period").notNull(), // e.g. "2026-11"
  metric: text("metric").notNull(), // closed_revenue_aed | qualified_leads | rfqs | quotations
  value: numeric("value", { precision: 18, scale: 2 }).notNull(),
  setByUserId: uuid("set_by_user_id").references(() => users.id),
  isAssumption: boolean("is_assumption").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("business_targets_period_metric_uq").on(t.period, t.metric)]);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // daily_performance | weekly_exec | kpi_plan | pipeline_review | lead_quality
  title: text("title").notNull(),
  periodStart: ts("period_start"),
  periodEnd: ts("period_end"),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  narrative: text("narrative"),
  authorEmployeeId: uuid("author_employee_id").references(() => aiEmployees.id),
  taskId: uuid("task_id"),
  createdAt: createdAt(),
});

// ───────────────────── operations / audit / config ─────────────────────

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(), // e.g. task.started, lead.scored, opportunity.stage_changed
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    summary: text("summary").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_log_created_idx").on(t.createdAt),
    index("activity_log_actor_idx").on(t.actorType, t.actorId, t.createdAt),
    index("activity_log_entity_idx").on(t.entityType, t.entityId),
  ],
);

export const schedules = pgTable("schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  cron: text("cron").notNull(), // 5-field cron, evaluated in `timezone`
  timezone: text("timezone").notNull().default("Asia/Dubai"),
  taskType: text("task_type").notNull(),
  assigneeRoleKey: text("assignee_role_key").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: ts("last_run_at"),
  lastSlot: text("last_slot"),
  createdAt: createdAt(),
});

export const modelRoutes = pgTable("model_routes", {
  profile: text("profile").primaryKey(), // reasoning | sales_writing | technical | research_realtime | classification
  provider: text("provider").notNull(), // anthropic | xai
  model: text("model").notNull(),
  effort: text("effort"), // anthropic effort level
  description: text("description").notNull(),
  updatedAt: updatedAt(),
});

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id").references(() => aiEmployees.id),
    taskId: uuid("task_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    profile: text("profile").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    success: boolean("success").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_created_idx").on(t.createdAt)],
);
