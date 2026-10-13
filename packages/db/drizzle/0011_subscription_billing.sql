ALTER TABLE "usage_events" ADD COLUMN "billing" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "api_equivalent_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Claude Code CLI and ChatGPT-plan calls run on a subscription: their recorded cost was an API-price estimate, not spend.
UPDATE "usage_events" SET "billing" = 'subscription', "api_equivalent_micro_usd" = "cost_micro_usd", "cost_micro_usd" = 0 WHERE "model" LIKE 'claude-code/%' OR "model" LIKE 'chatgpt/%';
