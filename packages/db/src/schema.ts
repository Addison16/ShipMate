import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const userRole = pgEnum("user_role", ["owner", "admin", "member"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"),
  oidcSubject: text("oidc_subject").unique(),
  role: userRole("role").notNull().default("member"),
  /** Monthly cost cap in USD cents; null = no cap. */
  monthlyCapCents: integer("monthly_cap_cents"),
  /** Linked Discord account (phase 3). */
  discordUserId: text("discord_user_id").unique(),
  /** Linked Telegram account (phase 5). */
  telegramUserId: text("telegram_user_id").unique(),
  /** Linked Slack account in the connected workspace (phase 5). */
  slackUserId: text("slack_user_id").unique(),
  /** Web app appearance (theme mode, color theme); parsed with UserPreferences. */
  preferences: jsonb("preferences").notNull().default({}),
  createdAt: createdAt(),
});

export const crewMembers = pgTable("crew_members", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  model: text("model").notNull(),
  captain: boolean("captain").notNull().default(false),
  visibility: text("visibility").notNull().default("shared"),
  /** Owner of a private crew member; null for shared crew. */
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  /** Parsed crew.yaml, cached from disk. Disk is the source of truth. */
  manifest: jsonb("manifest").notNull(),
  /** active | pending_review (recruited by the Captain, awaiting a person's review). */
  status: text("status").notNull().default("active"),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    /** "bridge" = group chat with the Captain; "direct" = one crew member. */
    kind: text("kind").notNull().default("bridge"),
    /** Where it lives: web, discord, routine. */
    surface: text("surface").notNull().default("web"),
    externalId: text("external_id"),
    /** For "direct" conversations: the crew member being talked to. */
    crewMemberId: uuid("crew_member_id").references(() => crewMembers.id, { onDelete: "set null" }),
    /** Shipyard project whose workspace this conversation works in. */
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    /** pi session file per crew member slug, so a conversation resumes with full context. */
    sessionFiles: jsonb("session_files").$type<Record<string, string>>().notNull().default({}),
    /** Pinned to the top of the person's list; null = not pinned. */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Set when a human wrote it. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when a crew member wrote it. */
    crewMemberId: uuid("crew_member_id").references(() => crewMembers.id, { onDelete: "set null" }),
    role: text("role").notNull(), // user | assistant | system | tool
    content: text("content").notNull(),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    // Conversation search; queries must use the same expression to hit it.
    index("messages_content_search_idx").using("gin", sql`to_tsvector('english', ${t.content})`),
  ],
);

export const providers = pgTable("providers", {
  id: id(),
  /** anthropic | openai | xai | google | openrouter | ollama | openai-compatible | claude-code-cli */
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  baseUrl: text("base_url"),
  /** Vault reference, never the secret itself. */
  secretRef: text("secret_ref"),
  /** Model ids for self-hosted kinds (ollama, openai-compatible), probed or typed in. */
  models: jsonb("models").$type<string[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const secrets = pgTable("secrets", {
  ref: text("ref").primaryKey(),
  /** AES-256-GCM: iv || ciphertext || tag, base64. */
  ciphertext: text("ciphertext").notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per model call, so cost is attributable per user, crew and routine (Q3, Q4). */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    crewMemberId: uuid("crew_member_id").references(() => crewMembers.id, { onDelete: "set null" }),
    routineId: uuid("routine_id"),
    conversationId: uuid("conversation_id"),
    model: text("model").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("usage_user_time_idx").on(t.userId, t.createdAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    crewMemberId: uuid("crew_member_id").references(() => crewMembers.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    decision: text("decision"), // approved | denied | auto
    detail: jsonb("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_time_idx").on(t.createdAt)],
);

/** Browser sessions. The cookie holds a random token; only its SHA-256 is stored. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

/** Instance settings (captain name, default model, ...), one JSON value per key. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
}));
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}));

/** Watches (routines): a crew member runs a prompt on a schedule, webhook or after another. */
export const watches = pgTable("watches", {
  id: id(),
  name: text("name").notNull(),
  crewSlug: text("crew_slug").notNull(),
  /** WatchTrigger from @shipmate/core. */
  trigger: jsonb("trigger").notNull(),
  prompt: text("prompt").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** fresh | continue */
  session: text("session").notNull().default("fresh"),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Secret part of the webhook URL. */
  webhookToken: text("webhook_token").notNull(),
  /** pi session file reused when session = continue. */
  sessionFile: text("session_file"),
  /** Monthly spend ceiling in USD cents; null = none. */
  monthlyCapCents: integer("monthly_cap_cents"),
  createdAt: createdAt(),
});

export const watchRuns = pgTable(
  "watch_runs",
  {
    id: id(),
    watchId: uuid("watch_id")
      .notNull()
      .references(() => watches.id, { onDelete: "cascade" }),
    /** running | succeeded | failed | waiting_approval */
    status: text("status").notNull().default("running"),
    /** schedule | manual | webhook | after */
    cause: text("cause").notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    output: text("output"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("watch_runs_watch_idx").on(t.watchId, t.startedAt),
    // At most one active run per watch, enforced by Postgres so it holds across processes.
    uniqueIndex("watch_runs_active_idx")
      .on(t.watchId)
      .where(sql`${t.status} in ('running', 'waiting_approval')`),
  ],
);

/** Installed catalog servers and custom servers. Core servers need no row. */
export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  /** For custom servers: the CatalogEntry-shaped spec. Null for catalog entries. */
  spec: jsonb("spec"),
  custom: boolean("custom").notNull().default(false),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- phase 3: Shipyard and Discord ----------

/** A software (or plain-folder) project the crew works on in /data/workspaces/<slug>. */
export const projects = pgTable("projects", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** github | local */
  provider: text("provider").notNull(),
  /** "owner/name" for GitHub. */
  repo: text("repo"),
  defaultBranch: text("default_branch"),
  crewSlug: text("crew_slug").notNull().default("shipwright"),
  /** Vault ref of the GitHub token, when one is stored. */
  tokenRef: text("token_ref"),
  /** Shared secret GitHub signs webhook deliveries with. */
  webhookSecret: text("webhook_secret").notNull(),
  sandboxImage: text("sandbox_image"),
  createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** GitHub webhook deliveries, kept for the project timeline and routed to conversations. */
export const projectEvents = pgTable(
  "project_events",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** X-GitHub-Delivery, so redeliveries are ignored. */
    deliveryId: text("delivery_id").unique(),
    summary: text("summary").notNull(),
    payload: jsonb("payload"),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("project_events_project_idx").on(t.projectId, t.createdAt)],
);

/** Which Discord channel (and webhook) each crew member speaks through. */
export const discordChannels = pgTable("discord_channels", {
  crewSlug: text("crew_slug").primaryKey(),
  channelId: text("channel_id").notNull(),
  webhookId: text("webhook_id"),
  /** Vault ref of the webhook token. */
  webhookTokenRef: text("webhook_token_ref"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Telegram chats (groups or DMs) mapped to the crew member who answers there (phase 5). */
export const telegramChats = pgTable("telegram_chats", {
  chatId: text("chat_id").primaryKey(),
  crewSlug: text("crew_slug").notNull(),
  /** The chat's title (or the person's name for a DM) when it was mapped. */
  title: text("title"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Which Slack channel each crew member speaks in (phase 5). */
export const slackChannels = pgTable("slack_channels", {
  crewSlug: text("crew_slug").primaryKey(),
  channelId: text("channel_id").notNull().unique(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- everyday life: shared lists and household profiles ----------

/** Grocery, to-do, packing and bill lists the household and the crew keep together. */
export const lists = pgTable(
  "lists",
  {
    id: id(),
    name: text("name").notNull(),
    /** grocery | todo | packing | bills | other */
    kind: text("kind").notNull().default("todo"),
    /** Null = shared with everyone on the instance; set = private to that person. */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lists_owner_idx").on(t.ownerId)],
);

export const listItems = pgTable(
  "list_items",
  {
    id: id(),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    checked: boolean("checked").notNull().default(false),
    position: integer("position").notNull().default(0),
    /** Optional due date (bills, to-dos), YYYY-MM-DD. */
    dueOn: date("due_on", { mode: "string" }),
    note: text("note"),
    /** Who added it: a person, or the person a crew member was working for. */
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Slug of the crew member that added it, when one did. */
    createdByCrew: text("created_by_crew"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("list_items_list_idx").on(t.listId, t.position)],
);

/**
 * Per-person facts every crew member can use (diet, budget, timezone, schedules), so nobody
 * repeats themselves to each bot. Household-wide facts live in settings under "household".
 */
export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** HouseholdProfile fields from @shipmate/core. */
  profile: jsonb("profile").notNull().default({}),
  /** Crew working for other people in the household may read it too (e.g. meal planning). */
  shared: boolean("shared").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
// ---------- phone, voice and files ----------

/** A browser or installed app subscribed to Web Push (one row per device). */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The push service URL; unique per browser profile. */
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** "Pixel 9, Chrome", guessed from the browser; the person can tell devices apart. */
    label: text("label").notNull(),
    /** Which notifications this device gets: { approvals, watches, messages }. */
    events: jsonb("events").$type<Record<string, boolean>>().notNull().default({}),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

/** Files people attach in chat. The bytes live in <data>/files/<id>; only the uploader reads them. */
export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Set once the file is sent with a message; unsent uploads are cleaned up after a day. */
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    /** image | pdf | text */
    kind: text("kind").notNull(),
    size: integer("size").notNull(),
    /** Text pulled out of a PDF or text file, passed to the model as text. */
    text: text("text"),
    createdAt: createdAt(),
  },
  (t) => [index("attachments_conversation_idx").on(t.conversationId)],
);
