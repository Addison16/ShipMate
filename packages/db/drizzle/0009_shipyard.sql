CREATE TABLE "shipyard_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_title" text NOT NULL,
	"user_id" uuid NOT NULL,
	"crew_slug" text NOT NULL,
	"conversation_id" uuid,
	"status" text DEFAULT 'working' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"branch" text,
	"pr_number" integer,
	"pr_url" text,
	"head_sha" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"review_rounds" integer DEFAULT 0 NOT NULL,
	"review_verdict" text,
	"review_notes" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "reviewer_slug" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "trigger_label" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "trigger_assignee" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "trigger_user_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "max_fix_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "webhook_last_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipyard_jobs" ADD CONSTRAINT "shipyard_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipyard_jobs" ADD CONSTRAINT "shipyard_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipyard_jobs" ADD CONSTRAINT "shipyard_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipyard_jobs_project_idx" ON "shipyard_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipyard_jobs_active_idx" ON "shipyard_jobs" USING btree ("project_id","issue_number") WHERE "shipyard_jobs"."status" in ('working', 'pr_open', 'ci_running', 'ci_failed', 'reviewing', 'addressing_review', 'needs_input', 'ready');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_trigger_user_id_users_id_fk" FOREIGN KEY ("trigger_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;