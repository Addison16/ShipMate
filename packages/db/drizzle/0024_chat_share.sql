ALTER TABLE "conversations" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "shared_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "shared_title" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_share_token_unique" UNIQUE("share_token");