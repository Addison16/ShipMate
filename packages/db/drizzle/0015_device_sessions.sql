ALTER TABLE "auth_sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "last_seen_at" timestamp with time zone;