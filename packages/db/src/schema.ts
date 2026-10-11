import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
    createdAt: createdAt(),
  },
  (t) => [index("conversations_user_idx").on(t.userId)],
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
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const providers = pgTable("providers", {
  id: id(),
  /** anthropic | openai | xai | google | openrouter | ollama | openai-compatible | claude-code-cli */
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  baseUrl: text("base_url"),
  /** Vault reference, never the secret itself. */
  secretRef: text("secret_ref"),
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

export const usersRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
}));
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}));
