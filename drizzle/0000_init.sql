CREATE TYPE "public"."actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."approval_action" AS ENUM('send_external_email', 'send_linkedin_message', 'launch_ad_campaign', 'publish_content', 'change_ad_budget', 'send_quotation', 'change_product_price', 'offer_discount', 'confirm_delivery_date', 'technical_commitment', 'sign_agreement', 'mark_deal_won');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_verification" AS ENUM('unverified', 'verified', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('idle', 'working', 'researching', 'writing', 'analyzing', 'contacting_customer', 'preparing_quotation', 'in_meeting', 'waiting_approval', 'blocked', 'error');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('pending', 'done', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lead_priority" AS ENUM('high_priority', 'qualified', 'needs_more_research', 'low_priority');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'researching', 'needs_more_research', 'qualified', 'low_priority', 'assigned', 'rejected', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('message', 'task_assignment', 'information_request', 'research_share', 'escalation', 'approval_request', 'report', 'acknowledgement');--> statement-breakpoint
CREATE TYPE "public"."office_location" AS ENUM('desk', 'executive_office', 'sales_department', 'marketing_department', 'lead_generation_department', 'research_department', 'meeting_room', 'operations_room', 'waiting_area');--> statement-breakpoint
CREATE TYPE "public"."pipeline_stage" AS ENUM('new_lead', 'researching', 'contact_identified', 'qualified', 'initial_contact_drafted', 'awaiting_approval', 'contacted', 'interested', 'rfq_received', 'technical_evaluation', 'quotation_preparation', 'quotation_sent', 'follow_up', 'negotiation', 'verbal_approval', 'won', 'lost', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."signal_strength" AS ENUM('confirmed_requirement', 'strong_buying_signal', 'potential_requirement', 'speculative');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'sales_manager', 'sales_user', 'marketing_manager', 'viewer');--> statement-breakpoint
CREATE TABLE "account_owners" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"owner_employee_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by_employee_id" uuid,
	"assigned_by_user_id" uuid,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"summary" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"content" text NOT NULL,
	"importance" integer DEFAULT 3 NOT NULL,
	"source_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"role_key" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"department_id" uuid NOT NULL,
	"manager_id" uuid,
	"persona" text NOT NULL,
	"job_description" text NOT NULL,
	"responsibilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"specialization" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_sales_executive" boolean DEFAULT false NOT NULL,
	"status" "employee_status" DEFAULT 'idle' NOT NULL,
	"location" "office_location" DEFAULT 'desk' NOT NULL,
	"current_task_id" uuid,
	"status_detail" text,
	"avatar_color" text DEFAULT '#3b82f6' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_employees_code_unique" UNIQUE("code"),
	CONSTRAINT "ai_employees_role_key_unique" UNIQUE("role_key")
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid,
	"task_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"profile" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"success" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "approval_action" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by_employee_id" uuid,
	"requested_by_user_id" uuid,
	"task_id" uuid,
	"related_type" text,
	"related_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"execution_status" text,
	"execution_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text NOT NULL,
	"metric" text NOT NULL,
	"value" numeric(18, 2) NOT NULL,
	"set_by_user_id" uuid,
	"is_assumption" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"objective" text,
	"target_industries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_budget_aed" numeric(14, 2),
	"actual_spend_aed" numeric(14, 2),
	"owner_employee_id" uuid,
	"external_id" text,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"website" text,
	"country" text,
	"city" text,
	"industry" text,
	"business_activity" text,
	"company_size" text,
	"company_size_verified" boolean DEFAULT false NOT NULL,
	"linkedin_url" text,
	"account_type" text,
	"odoo_partner_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text,
	"job_title" text,
	"is_decision_maker" boolean DEFAULT false NOT NULL,
	"email" text,
	"email_status" "email_verification" DEFAULT 'unverified' NOT NULL,
	"phone" text,
	"linkedin_url" text,
	"source_url" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"office_zone" "office_location" NOT NULL,
	"kpis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"owner_employee_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"purpose" text NOT NULL,
	"status" "follow_up_status" DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"employee_id" uuid,
	"user_id" uuid,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"subject" text,
	"body" text,
	"approval_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"evidence_type" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"published_at" date,
	"reliability" text DEFAULT 'medium' NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collected_by_employee_id" uuid,
	"collected_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"requirement_summary" text,
	"capacity_kva_min" real,
	"capacity_kva_max" real,
	"brand_preference" text,
	"signal_strength" "signal_strength" DEFAULT 'speculative' NOT NULL,
	"buying_signal" text,
	"has_active_project" boolean DEFAULT false NOT NULL,
	"purchase_timing" text,
	"score" integer,
	"priority" "lead_priority",
	"score_breakdown" jsonb,
	"scored_at" timestamp with time zone,
	"recommended_approach" text,
	"source" text NOT NULL,
	"source_url" text,
	"discovered_by_employee_id" uuid,
	"created_by_user_id" uuid,
	"duplicate_of_lead_id" uuid,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"attendee_employee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agenda" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minutes" text,
	"task_id" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid,
	"kind" "message_kind" DEFAULT 'message' NOT NULL,
	"from_employee_id" uuid,
	"from_user_id" uuid,
	"to_employee_id" uuid,
	"to_user_id" uuid,
	"subject" text,
	"body" text NOT NULL,
	"related_type" text,
	"related_id" uuid,
	"task_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"metric" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"is_estimate" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_routes" (
	"profile" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"effort" text,
	"description" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lead_id" uuid,
	"owner_employee_id" uuid NOT NULL,
	"title" text NOT NULL,
	"stage" "pipeline_stage" DEFAULT 'new_lead' NOT NULL,
	"capacity_kva" real,
	"brand_preference" text,
	"expected_value_aed" numeric(14, 2),
	"value_is_estimate" boolean DEFAULT true NOT NULL,
	"probability" integer,
	"expected_close_date" date,
	"next_action" text,
	"next_action_due" timestamp with time zone,
	"lost_reason" text,
	"disqualified_reason" text,
	"won_evidence" text,
	"actual_value_aed" numeric(14, 2),
	"gross_margin_aed" numeric(14, 2),
	"odoo_lead_id" integer,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownership_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_employee_id" uuid,
	"to_employee_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"changed_by_type" "actor_type" NOT NULL,
	"changed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"prime_kva" real,
	"standby_kva" real,
	"frequency_hz" integer,
	"voltage" text,
	"phase" integer,
	"engine_model" text,
	"alternator" text,
	"fuel_tank_liters" real,
	"canopy" text,
	"fuel_consumption_lph_75" real,
	"max_ambient_c" real,
	"price_aed" numeric(14, 2),
	"price_verified" boolean DEFAULT false NOT NULL,
	"availability" text,
	"lead_time_weeks" real,
	"source" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"rfq_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'AED' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_aed" numeric(14, 2),
	"validity_days" integer,
	"approval_id" uuid,
	"sent_at" timestamp with time zone,
	"created_by_employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"data" jsonb NOT NULL,
	"narrative" text,
	"author_employee_id" uuid,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_text" text,
	"requirements" jsonb,
	"extraction_method" text,
	"missing_info" jsonb,
	"conflicts" jsonb,
	"compliance_matrix" jsonb,
	"customer_questions" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Dubai' NOT NULL,
	"task_type" text NOT NULL,
	"assignee_role_key" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_slot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"from_stage" "pipeline_stage",
	"to_stage" "pipeline_stage" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assignee_employee_id" uuid NOT NULL,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" uuid,
	"parent_task_id" uuid,
	"related_type" text,
	"related_id" uuid,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"blocked_reason" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "account_owners_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "account_owners_owner_employee_id_ai_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "account_owners_assigned_by_employee_id_ai_employees_id_fk" FOREIGN KEY ("assigned_by_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "account_owners_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_employee_id_ai_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_employee_id_ai_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_employee_id_ai_employees_id_fk" FOREIGN KEY ("requested_by_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_targets" ADD CONSTRAINT "business_targets_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_employee_id_ai_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_owner_employee_id_ai_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_employee_id_ai_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_evidence" ADD CONSTRAINT "lead_evidence_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_evidence" ADD CONSTRAINT "lead_evidence_collected_by_employee_id_ai_employees_id_fk" FOREIGN KEY ("collected_by_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_evidence" ADD CONSTRAINT "lead_evidence_collected_by_user_id_users_id_fk" FOREIGN KEY ("collected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_discovered_by_employee_id_ai_employees_id_fk" FOREIGN KEY ("discovered_by_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_employee_id_ai_employees_id_fk" FOREIGN KEY ("from_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_employee_id_ai_employees_id_fk" FOREIGN KEY ("to_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_employee_id_ai_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_history" ADD CONSTRAINT "ownership_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_history" ADD CONSTRAINT "ownership_history_from_employee_id_ai_employees_id_fk" FOREIGN KEY ("from_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_history" ADD CONSTRAINT "ownership_history_to_employee_id_ai_employees_id_fk" FOREIGN KEY ("to_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_employee_id_ai_employees_id_fk" FOREIGN KEY ("created_by_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_author_employee_id_ai_employees_id_fk" FOREIGN KEY ("author_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_employee_id_ai_employees_id_fk" FOREIGN KEY ("assignee_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_log_actor_idx" ON "activity_log" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_entity_idx" ON "activity_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "agent_memories_emp_idx" ON "agent_memories" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "agent_memories_subject_idx" ON "agent_memories" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "ai_employees_dept_idx" ON "ai_employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "business_targets_period_metric_uq" ON "business_targets" USING btree ("period","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_uq" ON "companies" USING btree ("domain") WHERE "companies"."domain" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_name_country_uq" ON "companies" USING btree ("normalized_name",coalesce("country", ''));--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "follow_ups_owner_due_idx" ON "follow_ups" USING btree ("owner_employee_id","due_at");--> statement-breakpoint
CREATE INDEX "follow_ups_opp_idx" ON "follow_ups" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "interactions_opp_idx" ON "interactions" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "interactions_company_idx" ON "interactions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "knowledge_category_idx" ON "knowledge_items" USING btree ("category");--> statement-breakpoint
CREATE INDEX "lead_evidence_lead_idx" ON "lead_evidence" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_company_open_uq" ON "leads" USING btree ("company_id") WHERE "leads"."status" not in ('rejected', 'duplicate', 'assigned');--> statement-breakpoint
CREATE INDEX "messages_to_idx" ON "messages" USING btree ("to_employee_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_from_idx" ON "messages" USING btree ("from_employee_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin (to_tsvector('english', coalesce("subject", '') || ' ' || "body"));--> statement-breakpoint
CREATE INDEX "metric_snapshots_lookup_idx" ON "metric_snapshots" USING btree ("scope","scope_id","metric","period_start");--> statement-breakpoint
CREATE INDEX "opportunities_owner_idx" ON "opportunities" USING btree ("owner_employee_id");--> statement-breakpoint
CREATE INDEX "opportunities_stage_idx" ON "opportunities" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_lead_uq" ON "opportunities" USING btree ("lead_id") WHERE "opportunities"."lead_id" is not null;--> statement-breakpoint
CREATE INDEX "ownership_history_company_idx" ON "ownership_history" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "products_kva_idx" ON "products" USING btree ("prime_kva");--> statement-breakpoint
CREATE INDEX "quotations_opp_idx" ON "quotations" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "rfqs_opp_idx" ON "rfqs" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stage_transitions_opp_idx" ON "stage_transitions" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "tasks_queue_idx" ON "tasks" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_employee_id","status");--> statement-breakpoint
CREATE INDEX "tasks_related_idx" ON "tasks" USING btree ("related_type","related_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_dedupe_active_uq" ON "tasks" USING btree ("dedupe_key") WHERE "tasks"."dedupe_key" is not null and "tasks"."status" in ('queued', 'running', 'waiting_approval', 'blocked');