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
  /** Linked Discord account (phase 3); messages from it are attributed to this person. */
  discordUserId: string | null;
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
  /** Where it lives: web, discord, watch. */
  surface: string;
  /** Shipyard project this conversation works in (phase 3); tools run in its workspace. */
  projectId: string | null;
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
  /** capUsd: the crew member's monthlyCapUsd from crew.yaml (phase 4). */
  byCrew: Array<UsageTotals & { slug: string | null; name: string; capUsd: number | null }>;
  byModel: Array<UsageTotals & { model: string }>;
  /** Spend per watch (routine) this month (phase 4). */
  byWatch: Array<
    UsageTotals & { watchId: string; name: string; capCents: number | null }
  >;
  /** One entry per UTC day of the month up to today, zeros included (phase 4). */
  daily: Array<{ date: string; costMicroUsd: number; calls: number }>;
}
/**
 * GET /api/usage?month=YYYY-MM&scope=me|all → UsageResponse (scope=all needs owner or admin)
 * GET /api/usage/export?month=YYYY-MM&scope=me|all → text/csv, one row per model call (phase 4)
 * Ceilings (phase 4): a turn is refused when the person's monthly cap, the crew member's
 * `monthlyCapUsd`, or (for watch runs) the watch's `monthlyCapCents` is reached.
 */

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

// ---------- skills (phase 2) ----------

export type SkillScope = "crew" | "user" | "instance";

export interface SkillDto {
  /** `<scope>:<owner>:<name>`, e.g. `crew:galley:weekly-meal-plan`, `instance:-:pdf-tools`. */
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  /** Set for crew scope. */
  crewSlug: string | null;
  /** Set for user scope (only that person's sessions load it). */
  ownerUserId: string | null;
  /** Bot-made skills start pending and are not loaded until approved. */
  status: "active" | "pending";
  /** "user" when written by a person, else the slug of the crew member that wrote it. */
  author: string;
  updatedAt: string;
}
export interface SkillDetailDto extends SkillDto {
  /** Full SKILL.md text, frontmatter included. */
  content: string;
}
/**
 * GET /api/skills → { skills: SkillDto[] } (user-scope skills: only the caller's own)
 * GET /api/skills/:id → { skill: SkillDetailDto }
 * POST /api/skills → { skill: SkillDetailDto } (crew and instance scope need admin)
 * PUT /api/skills/:id { content } → { skill } (same permission as create)
 * POST /api/skills/:id/approve → { skill } (admin, or the owner for user scope)
 * DELETE /api/skills/:id → { ok: true }
 */
export interface CreateSkillRequest {
  scope: SkillScope;
  crewSlug?: string;
  /** Full SKILL.md text; `name` and `description` frontmatter are required. */
  content: string;
}

// ---------- approvals and audit (phase 2) ----------

export type ApprovalDecision = "allow" | "deny" | "always";

export interface ApprovalDto {
  id: string;
  /** Null for routine runs. */
  conversationId: string | null;
  routineId: string | null;
  crew: { slug: string; name: string };
  toolName: string;
  /** One line for the card. */
  summary: string;
  /** The tool arguments, pretty-printed JSON, for "show details". */
  detail: string;
  createdAt: string;
}
/**
 * Consequential tool calls (shell, sending, publishing, deleting, pushing, installing) pause
 * until the person who started the turn decides. "always" adds the tool to the crew member's
 * `allow` list in crew.yaml so it is not asked again.
 *
 * GET /api/approvals → { approvals: ApprovalDto[] } (the caller's pending ones)
 * POST /api/approvals/:id { decision: ApprovalDecision } → { ok: true }
 */

export interface AuditEventDto {
  id: string;
  user: { id: string; name: string } | null;
  crew: { slug: string; name: string } | null;
  /** Tool name, or a Shipmate action like `crew.recruit`, `skill.approve`, `mcp.install`. */
  action: string;
  summary: string;
  /** auto | approved | denied | blocked | always */
  decision: string | null;
  createdAt: string;
}
/**
 * GET /api/audit?crew=<slug>&user=<id>&before=<iso>&limit=<n> → { events: AuditEventDto[] }
 * newest first. Members see only their own events; owner and admin see everyone's.
 */

// ---------- watches (routines, phase 2) ----------

export type WatchTrigger =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; everyMinutes: number }
  | { kind: "webhook" }
  | { kind: "after"; routineId: string };

export interface WatchDto {
  id: string;
  name: string;
  crewSlug: string;
  trigger: WatchTrigger;
  prompt: string;
  enabled: boolean;
  /** Continue the crew member's previous session for this watch, or start fresh each run. */
  session: "fresh" | "continue";
  owner: { id: string; name: string };
  /** For webhook triggers: POST here to run it (contains a secret token). Owner only. */
  webhookUrl: string | null;
  lastRun: WatchRunDto | null;
  nextRunAt: string | null;
  /** Monthly spend ceiling for this watch in USD cents; null = none (phase 4). */
  monthlyCapCents: number | null;
  createdAt: string;
}
export interface WatchRunDto {
  id: string;
  watchId: string;
  status: "running" | "succeeded" | "failed" | "waiting_approval";
  /** What started it: schedule, manual, webhook, after. */
  cause: string;
  startedAt: string;
  finishedAt: string | null;
  /** The crew member's final reply. */
  output: string | null;
  error: string | null;
  costMicroUsd: number;
  /** Full transcript: GET /api/conversations/:id/messages. */
  conversationId: string | null;
}
/**
 * GET /api/watches → { watches: WatchDto[] } (everyone's; shared crew)
 * POST /api/watches → { watch } ; PATCH /api/watches/:id → { watch } (owner of the watch or admin)
 * DELETE /api/watches/:id → { ok: true }
 * POST /api/watches/:id/run → { run: WatchRunDto } (starts now, returns the running run)
 * GET /api/watches/:id/runs?limit=n → { runs: WatchRunDto[] } newest first
 * POST /api/hooks/watches/:id/:token → { run } (public webhook trigger; body text is appended
 *   to the prompt)
 */
export interface CreateWatchRequest {
  name: string;
  crewSlug: string;
  trigger: WatchTrigger;
  prompt: string;
  enabled?: boolean;
  session?: "fresh" | "continue";
  monthlyCapCents?: number | null;
}
export type UpdateWatchRequest = Partial<CreateWatchRequest>;

// ---------- MCP servers (phase 2) ----------

export interface McpSecretDto {
  env: string;
  label: string;
  required: boolean;
  /** Whether a value is stored; values are never returned. */
  set: boolean;
}
export interface McpServerDto {
  id: string;
  name: string;
  description: string;
  /** core = bundled; catalog = one-click install; custom = added by an owner. */
  tier: "core" | "catalog" | "custom";
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  /** Core servers are always installed. */
  installed: boolean;
  secrets: McpSecretDto[];
  /** Ready to start: installed and every required secret set. */
  ready: boolean;
  /** Slugs of crew members whose crew.yaml lists it. */
  crews: string[];
  tags: string[];
  homepage: string | null;
}
/**
 * GET /api/mcp → { servers: McpServerDto[] } (any signed-in user)
 * POST /api/mcp/:id/install (owner) → { server }   DELETE /api/mcp/:id (owner) → uninstall
 *   (custom servers are removed; catalog ones are marked not installed)
 * PUT /api/mcp/:id/secrets (owner) { values: Record<env, string> } → { server } ("" clears one)
 * PUT /api/mcp/:id/crews (admin) { crews: string[] } → { server } (edits each crew.yaml mcp list)
 * POST /api/mcp/custom (owner) CreateCustomMcpRequest → { server }
 */
export interface CreateCustomMcpRequest {
  id: string;
  name: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Env var names the server needs; values are set afterwards via /secrets. */
  secrets?: Array<{ env: string; label?: string; required?: boolean }>;
}

// ---------- Discord bridge (phase 3) ----------

export interface DiscordChannelDto {
  crewSlug: string;
  crewName: string;
  /** Null until synced or bound. */
  channelId: string | null;
  channelName: string | null;
  /** A webhook exists, so this crew member posts under its own name and avatar. */
  webhook: boolean;
}
export interface DiscordStatusDto {
  /** A bot token is stored. */
  configured: boolean;
  /** The bot is connected to Discord's gateway right now. */
  connected: boolean;
  applicationId: string | null;
  guildId: string | null;
  guildName: string | null;
  /** Last connection or sync problem, in plain words. */
  error: string | null;
  /** Add-the-bot-to-a-server link, once the application id is known. */
  inviteUrl: string | null;
  channels: DiscordChannelDto[];
}
/**
 * One Discord application per instance; each active crew member gets a channel (in a
 * "Shipmate" category) and posts through that channel's webhook with its own name and avatar.
 * A person links their Discord account once; messages from unlinked accounts are not run.
 *
 * GET /api/discord → { discord: DiscordStatusDto } (any signed-in user; secrets never returned)
 * PUT /api/discord (owner) { botToken?: string, guildId?: string } → { discord } (reconnects)
 * DELETE /api/discord (owner) → { ok: true } (disconnects and forgets the token)
 * POST /api/discord/sync (admin) → { discord } (creates missing channels and webhooks)
 * PUT /api/discord/channels/:slug (admin) { channelId: string | null } → { discord }
 *   (bind a crew member to an existing channel, or null to unbind)
 * POST /api/discord/link → DiscordLinkCode (the caller types it in Discord to link)
 * DELETE /api/discord/link → { ok: true } (unlink the caller)
 */
export interface DiscordLinkCode {
  code: string;
  expiresAt: string;
  /** What to type in Discord, e.g. "/shipmate link 123456". */
  instructions: string;
}

// ---------- Shipyard (phase 3) ----------

export interface ShipyardStatusDto {
  /** False when the Docker socket is missing: projects can be listed but no code runs. */
  available: boolean;
  /** Why not, in plain words. */
  reason: string | null;
  /** Default sandbox image for new projects. */
  sandboxImage: string;
}
export type ProjectProvider = "github" | "local";
export interface ProjectDto {
  id: string;
  slug: string;
  name: string;
  provider: ProjectProvider;
  /** "owner/name" for GitHub; null for a local project. */
  repo: string | null;
  defaultBranch: string | null;
  /** The crew member who works on it (default: shipwright). */
  crewSlug: string;
  /** A GitHub token is stored for this project (never returned). */
  hasToken: boolean;
  workspace: {
    cloned: boolean;
    branch: string | null;
    /** Uncommitted changes; null when unknown. */
    dirty: boolean | null;
  };
  sandbox: { status: "none" | "running" | "stopped" | "unavailable"; image: string };
  /** GitHub webhook to configure on the repo (owner/admin only; contains no secret). */
  webhookUrl: string | null;
  /** The webhook secret to paste into GitHub (owner/admin only). */
  webhookSecret: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}
export interface CreateProjectRequest {
  name: string;
  slug?: string;
  provider: ProjectProvider;
  /** "owner/name", required for github. */
  repo?: string;
  /** Fine-grained PAT with contents, pull requests and issues access. */
  token?: string;
  crewSlug?: string;
  defaultBranch?: string;
  sandboxImage?: string;
}
/** `token: ""` clears the stored token. */
export type UpdateProjectRequest = Partial<Omit<CreateProjectRequest, "provider">>;
export interface PullRequestDto {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  url: string;
  branch: string;
  author: string;
  /** Combined CI state of the head commit; null when unknown. */
  checks: "pending" | "success" | "failure" | null;
  updatedAt: string;
}
export interface IssueDto {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
  author: string;
  updatedAt: string;
}
export interface ProjectEventDto {
  id: string;
  /** GitHub event name, e.g. pull_request, check_suite, issue_comment. */
  kind: string;
  summary: string;
  /** The conversation it was routed to, when a crew member is following that PR. */
  conversationId: string | null;
  createdAt: string;
}
export type ShipyardFlow = "plan" | "fix_issue" | "review_pr" | "triage" | "keep_ci_green";
export interface StartFlowRequest {
  flow: ShipyardFlow;
  /** Issue number (fix_issue) or PR number (review_pr, keep_ci_green). */
  target?: number;
  /** Extra instructions from the person, e.g. the feature to plan. */
  notes?: string;
}
/**
 * The Shipyard: crew members work on code in per-project workspaces (/data/workspaces/<slug>);
 * shell commands run in a per-project sandbox container started through the Docker socket,
 * with the workspace mounted and none of Shipmate's secrets. Pushing and GitHub calls happen
 * outside the sandbox through Shipmate tools, behind approval gates.
 *
 * GET /api/shipyard → { status: ShipyardStatusDto, projects: ProjectDto[] }
 * POST /api/shipyard/projects (admin) CreateProjectRequest → { project }
 * GET /api/shipyard/projects/:id → { project }
 * PATCH /api/shipyard/projects/:id (admin) UpdateProjectRequest → { project }
 * DELETE /api/shipyard/projects/:id (admin) → { ok: true } (removes sandbox; keeps the folder)
 * POST /api/shipyard/projects/:id/clone (admin) → { project } (clone, or fetch if cloned)
 * POST /api/shipyard/projects/:id/sandbox (admin) { action: "start" | "stop" | "reset" } → { project }
 * GET /api/shipyard/projects/:id/pulls?state=open|closed|all → { pulls: PullRequestDto[] }
 * GET /api/shipyard/projects/:id/issues?state=open|closed|all → { issues: IssueDto[] }
 * GET /api/shipyard/projects/:id/events?limit=n → { events: ProjectEventDto[] }
 * POST /api/shipyard/projects/:id/flows StartFlowRequest → { conversationId } (a direct
 *   conversation with the project's crew member, started with the flow's prompt)
 * POST /api/shipyard/projects/:id/conversations → { conversation } (an empty one, for chat)
 * POST /api/hooks/github/:projectId (public; X-Hub-Signature-256 checked) → { ok: true }
 */

// ---------- sign-in with OIDC (phase 4) ----------

/** GET /api/auth/oidc (public) → OidcPublicDto: whether the login page shows the SSO button. */
export interface OidcPublicDto {
  enabled: boolean;
  /** Button text, e.g. "Sign in with Authentik". */
  label: string;
}
export interface OidcSettingsDto {
  enabled: boolean;
  /** Issuer URL; discovery is read from <issuer>/.well-known/openid-configuration. */
  issuer: string;
  clientId: string;
  /** A client secret is stored (never returned). */
  hasClientSecret: boolean;
  label: string;
  /** Create a member account on first sign-in; otherwise only existing emails may sign in. */
  allowSignup: boolean;
  /** Only these email domains may sign up (empty = any). */
  allowedDomains: string[];
  /** Register this in the identity provider. */
  redirectUri: string;
}
/**
 * GET /api/auth/oidc/start?next=<hash route> → 302 to the provider (public; PKCE + state + nonce)
 * GET /api/auth/oidc/callback → 302 to SHIPMATE_URL (session cookie set) or to /#/login?error=…
 *   Matches users by `oidcSubject`, else by verified email (then stores the subject).
 * GET /api/settings/oidc (owner) → { oidc: OidcSettingsDto }
 * PUT /api/settings/oidc (owner) Partial<{ enabled, issuer, clientId, clientSecret, label,
 *   allowSignup, allowedDomains }> → { oidc } (clientSecret "" clears; discovery is checked)
 */

// ---------- backups (phase 4) ----------

export interface BackupDto {
  /** File name, e.g. shipmate-2026-10-11T0300Z.tar.gz */
  name: string;
  sizeBytes: number;
  createdAt: string;
  /** "manual" | "scheduled" | "cli" */
  trigger: string;
}
export interface BackupSettingsDto {
  /** Nightly backups at this UTC hour (0-23); null = off. */
  hourUtc: number | null;
  /** Keep this many most recent backups; older ones are deleted. */
  keep: number;
  /** Where backups are written (inside the data volume by default). */
  dir: string;
}
/**
 * A backup is one .tar.gz holding a JSON-lines dump of every table plus the data folder
 * (crew, skills, workspaces excluded by default, pi config). Secrets stay encrypted, so
 * SHIPMATE_SECRET (or /data/.secret, which is included) is needed to read them after a restore.
 *
 * GET /api/backups (owner) → { backups: BackupDto[], settings: BackupSettingsDto }
 * POST /api/backups (owner) → { backup } (runs now)
 * GET /api/backups/:name (owner) → the file (download)
 * DELETE /api/backups/:name (owner) → { ok: true }
 * PUT /api/backups/settings (owner) Partial<{ hourUtc, keep }> → { settings }
 * CLI: `shipmate backup [--out file]`, `shipmate restore <file> --yes`, `shipmate doctor`
 */

// ---------- WebSocket: /api/ws ----------

export type ClientEvent =
  | { type: "send"; conversationId: string; text: string }
  | { type: "abort"; conversationId: string }
  /** Answer an approval_request (phase 2). */
  | { type: "approve"; approvalId: string; decision: ApprovalDecision };

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
  | { type: "error"; conversationId?: string; message: string }
  /** A crew member wants to run a consequential tool; show a card with allow/deny/always. */
  | { type: "approval_request"; approval: ApprovalDto }
  /** Decided (here or on another tab); remove the card. */
  | { type: "approval_resolved"; approvalId: string; decision: ApprovalDecision | "expired" }
  /** Skill list changed (created, approved, deleted); refetch /api/skills. */
  | { type: "skills_changed" }
  /** A watch run started or finished; failures should surface as a notice. */
  | { type: "watch_run"; watchName: string; run: WatchRunDto };
