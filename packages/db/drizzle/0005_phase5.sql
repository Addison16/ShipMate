CREATE TABLE "slack_channels" (
	"crew_slug" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_channels_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"crew_slug" text NOT NULL,
	"title" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "slack_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_slack_user_id_unique" UNIQUE("slack_user_id");