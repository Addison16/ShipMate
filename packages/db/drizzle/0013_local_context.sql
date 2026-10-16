ALTER TABLE "providers" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "model_contexts" jsonb DEFAULT '{}'::jsonb NOT NULL;