/**
 * HTTP and WebSocket contract between the Shipmate server and its clients (the web app and,
 * later, bridges). Types only, so the web bundle can import them without pulling in zod.
 *
 * All JSON. Timestamps are ISO strings. Auth is a `shipmate_session` http-only cookie set by
 * `/api/setup` and `/api/auth/login`. Errors are `{ error: string }` with a 4xx/5xx status.
 */
import type { UserRole } from "./user.js";

// ---------- users and auth ----------

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  /** Monthly cost cap in USD cents; null = no cap. */
  monthlyCapCents: number | null;
  createdAt: string;
}

/** GET /api/auth/me */
export interface MeResponse {
  user: UserDto | null;
  /** True until the owner account exists; the web app shows the first-run setup page. */
  setupRequired: boolean;
}

/** POST /api/setup (only while setupRequired) → { user: UserDto } and sets the session cookie. */
export interface SetupRequest {
  email: string;
  displayName: string;
  password: string;
  /** Optional rename of the coordinator; defaults to "Captain". */
  captainName?: string;
}

/** POST /api/auth/login → { user: UserDto }. POST /api/auth/logout → { ok: true }. */
export interface LoginRequest {
  email: string;
  password: string;
}

/** GET /api/users (owner, admin) → { users: UserDto[] } */
/** POST /api/users (owner, admin; only owner may create admins) → { user: UserDto } */
export interface CreateUserRequest {
  email: string;
  displayName: string;
  password: string;
  role: UserRole;
}
/**
 * PATCH /api/users/:id → { user: UserDto }. Owner may change anything on anyone except demoting
 * themselves; any user may change their own displayName and password.
 */
export interface UpdateUserRequest {
  displayName?: string;
  role?: UserRole;
  monthlyCapCents?: number | null;
  password?: string;
}
/** DELETE /api/users/:id (owner; not self) → { ok: true } */

// ---------- providers and models ----------

export type ProviderAuth = "api-key" | "oauth" | "external" | "none" | "optional-key";

export interface ProviderKindDto {
  kind: string;
  label: string;
  auth: ProviderAuth;
  /** True when a phase after 1 implements it; the UI shows it disabled with "coming soon". */
  comingSoon?: boolean;
}

export interface ProviderDto {
  id: string;
  kind: string;
  label: string;
  baseUrl: string | null;
  /** Whether a key is stored. The key itself is never returned. */
  hasSecret: boolean;
  enabled: boolean;
  /** Model ids for self-hosted kinds (ollama, openai-compatible); empty for built-in catalogs. */
  models: string[];
  createdAt: string;
}

/** GET /api/providers (any signed-in user) → ProvidersResponse */
export interface ProvidersResponse {
  providers: ProviderDto[];
  kinds: ProviderKindDto[];
}
/** POST /api/providers (owner) → { provider: ProviderDto } */
export interface CreateProviderRequest {
  kind: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}
/** PATCH /api/providers/:id (owner) → { provider }. apiKey "" clears the stored key. */
export interface UpdateProviderRequest {
  label?: string;
  baseUrl?: string | null;
  apiKey?: string;
  enabled?: boolean;
  models?: string[];
}
/** DELETE /api/providers/:id (owner) → { ok: true } */
/**
 * POST /api/providers/:id/probe (owner) → { models: string[] }. For self-hosted kinds, lists
 * `<baseUrl>/models` and saves the result on the provider.
 */

export interface ModelOption {
  /** `provider/model-id`, the form crew.yaml uses. */
  ref: string;
  provider: string;
  id: string;
  name: string;
  /** Credentials are configured so this model can actually be called. */
  available: boolean;
}
/** GET /api/models → { models: ModelOption[] } (available ones first). */

// ---------- crew ----------

export type CrewStatus = "active" | "pending_review" | "retired";

export interface CrewDto {
  slug: string;
  name: string;
  role: string;
  model: string;
  captain: boolean;
  visibility: "shared" | "private";
  status: CrewStatus;
  tools: string[];
  mcp: string[];
  skills: string[];
  avatar: string | null;
}

export interface CrewDetailDto extends CrewDto {
  /** Raw crew.yaml text, for the editor. */
  manifestYaml: string;
  /** Raw CREW.md text. */
  persona: string;
}

/** GET /api/crew → { crew: CrewDto[] } (retired excluded unless ?all=1) */
/** GET /api/crew/:slug → { crew: CrewDetailDto } */
/** POST /api/crew (admin) → { crew: CrewDetailDto } */
export interface CreateCrewRequest {
  slug: string;
  /** Either the full YAML or the structured fields below. */
  manifestYaml?: string;
  name?: string;
  role?: string;
  model?: string;
  persona: string;
}
/** PUT /api/crew/:slug (admin) → { crew: CrewDetailDto }. Invalid YAML → 400 with the reason. */
export interface UpdateCrewRequest {
  manifestYaml?: string;
  persona?: string;
}
/** POST /api/crew/:slug/approve (admin) → { crew: CrewDetailDto }; pending_review → active. */
/** DELETE /api/crew/:slug (admin; not the Captain) → { ok: true }; retires it. */

export interface MemoryEntryDto {
  /** File name without .md; stable id within its scope. */
  name: string;
  description: string;
  body: string;
  scope: "shared" | "user";
  updatedAt: string;
}
/**
 * GET /api/crew/:slug/memory → { shared: MemoryEntryDto[], mine: MemoryEntryDto[] }
 * DELETE /api/crew/:slug/memory/:scope/:name → { ok: true } (shared needs admin)
 */

// ---------- conversations (the Bridge) ----------

export interface ConversationDto {
  id: string;
  title: string | null;
  /** "bridge" talks to the Captain; "direct" talks to one crew member. */
  kind: "bridge" | "direct";
  crewSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageAuthor =
  | { kind: "user"; id: string; name: string }
  | { kind: "crew"; slug: string; name: string }
  | { kind: "system" };

export interface MessageDto {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  author: MessageAuthor;
  /** e.g. { handoff: { from, to, task } } for a delegated reply, { tools: [...] } summaries. */
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** GET /api/conversations → { conversations: ConversationDto[] } newest first */
/** POST /api/conversations { kind?, crewSlug? } → { conversation } */
/** PATCH /api/conversations/:id { title } → { conversation } */
/** DELETE /api/conversations/:id → { ok: true } */
/** GET /api/conversations/:id/messages → { messages: MessageDto[] } oldest first */

// ---------- usage ----------

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number;
}

export interface UsageResponse {
  /** YYYY-MM, UTC. */
  month: string;
  totals: UsageTotals;
  byUser: Array<
    UsageTotals & { userId: string | null; displayName: string; capCents: number | null }
  >;
  byCrew: Array<UsageTotals & { slug: string | null; name: string }>;
  byModel: Array<UsageTotals & { model: string }>;
}
/** GET /api/usage?month=YYYY-MM&scope=me|all → UsageResponse (scope=all needs owner or admin) */

// ---------- settings ----------

export interface SettingsDto {
  captainName: string;
  captainSlug: string;
  /** Model new crew members get when the Captain does not choose one. */
  defaultModel: string;
  /** Core MCP servers are started for crew sessions. */
  mcpEnabled: boolean;
}
/** GET /api/settings → SettingsDto. PUT /api/settings (owner) Partial<captainName, defaultModel> → SettingsDto */

// ---------- WebSocket: /api/ws ----------

export type ClientEvent =
  | { type: "send"; conversationId: string; text: string }
  | { type: "abort"; conversationId: string };

export type ServerEvent =
  | { type: "hello"; version: string; userId: string }
  /** A persisted message: the user's own echo, or a crew member's completed reply. */
  | { type: "message"; conversationId: string; message: MessageDto }
  /** A crew member starts streaming a reply (the Captain, or a crew member it delegated to). */
  | {
      type: "stream_start";
      conversationId: string;
      streamId: string;
      crew: { slug: string; name: string };
    }
  | { type: "delta"; conversationId: string; streamId: string; text: string }
  | {
      type: "tool";
      conversationId: string;
      streamId: string;
      phase: "start" | "end";
      toolCallId: string;
      toolName: string;
      /** Short human-readable summary of arguments (start) or result (end). */
      summary: string;
      isError?: boolean;
    }
  | { type: "stream_end"; conversationId: string; streamId: string }
  | {
      type: "handoff";
      conversationId: string;
      from: { slug: string; name: string };
      to: { slug: string; name: string };
      task: string;
    }
  /** The conversation is working / done working; the UI disables send while busy. */
  | { type: "status"; conversationId: string; busy: boolean }
  /** Crew roster changed (recruit, edit, retire); refetch /api/crew. */
  | { type: "crew_changed" }
  | { type: "error"; conversationId?: string; message: string };
