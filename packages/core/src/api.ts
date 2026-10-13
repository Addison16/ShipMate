/**
 * HTTP and WebSocket contract between the Shipmate server and its clients (the web app and,
 * later, bridges). Types only, so the web bundle can import them without pulling in zod.
 *
 * All JSON. Timestamps are ISO strings. Auth is a `shipmate_session` http-only cookie set by
 * `/api/setup` and `/api/auth/login`. Errors are `{ error: string }` with a 4xx/5xx status.
 */
import type { CaptainVoice, OnboardingDto } from "./onboarding.js";
import type { GitHubWatchEvent } from "./routine.js";
import type { HouseholdFacts, PersonProfile, UserPreferences, UserRole } from "./user.js";

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
  /** Linked Telegram account (phase 5). */
  telegramUserId: string | null;
  /** Linked Slack account (phase 5). */
  slackUserId: string | null;
  /** Appearance settings for the web app; only shown to and changed by this user. */
  preferences: UserPreferences;
  /** True until this person has seen the first sign-in welcome (people the owner added). */
  welcomePending: boolean;
  createdAt: string;
}

/** GET /api/auth/me */
export interface MeResponse {
  user: UserDto | null;
  /** True until the owner account exists; the web app shows the first-run setup page. */
  setupRequired: boolean;
  /** The first-launch guide's state; only sent to the owner. */
  onboarding?: OnboardingDto;
}

/** POST /api/setup (only while setupRequired) → { user: UserDto } and sets the session cookie. */
export interface SetupRequest {
  email: string;
  displayName: string;
  password: string;
  /** Optional rename of the coordinator; defaults to "Captain". */
  captainName?: string;
}

/**
 * GET /api/onboarding (owner) → { onboarding: OnboardingDto }
 * PUT /api/onboarding (owner) OnboardingUpdate → { onboarding: OnboardingDto }
 * GET /api/onboarding/captain (owner) → CaptainSetupDto
 * PUT /api/onboarding/captain (owner) { name?, voice } → CaptainSetupDto; `voice` is a preset id
 *   from CAPTAIN_VOICES or free text, written as the `## Voice` section of the Captain's CREW.md.
 */
export interface CaptainSetupDto {
  name: string;
  /** Preset id, or "custom". */
  voiceId: string;
  /** The current `## Voice` section. */
  voice: string;
  /** The personality presets to pick from. */
  voices: CaptainVoice[];
}

/** PATCH /api/auth/preferences (signed in) → { user: UserDto }. Changes only the given fields. */
/** PATCH /api/auth/preferences; `welcome: "done"` closes the first sign-in welcome. */
export type UpdatePreferencesRequest = Partial<UserPreferences> & { welcome?: "done" };

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

// ---------- local models (Ollama) ----------

export interface LocalModelDto {
  /** Ollama model name with its tag, e.g. "qwen3:4b". */
  name: string;
  sizeBytes: number | null;
}
export interface RecommendedModelDto {
  name: string;
  /** Approximate download size, e.g. "2.5 GB". */
  size: string;
  /** One line on what it is good for and what it needs. */
  note: string;
}
export interface LocalModelPullDto {
  model: string;
  status: "pulling" | "done" | "failed";
  /** Ollama's latest status line ("pulling manifest", "verifying sha256 digest", ...). */
  detail: string;
  completedBytes: number;
  /** 0 until Ollama reports the layer sizes. */
  totalBytes: number;
  error: string | null;
  startedAt: string;
}
export interface LocalAiStatusDto {
  /** The Ollama server checked (its root URL, without /v1). */
  url: string;
  reachable: boolean;
  /** Ollama's version when reachable. */
  version: string | null;
  /** Why it is not reachable, in plain words. */
  error: string | null;
  installed: LocalModelDto[];
  recommended: RecommendedModelDto[];
  /** The Ollama provider row, once Ollama is set up as a provider. */
  providerId: string | null;
  defaultModel: string;
  /** Pulls running now or finished in the last few minutes. */
  pulls: LocalModelPullDto[];
}
/**
 * The bundled Ollama service (docker compose --profile local-ai) or any Ollama server.
 * GET /api/local-ai?url= (owner) → { localAi: LocalAiStatusDto } (url defaults to the Ollama
 *   provider's server, else SHIPMATE_OLLAMA_URL, else http://ollama:11434)
 * POST /api/local-ai/pull (owner) { url?, model } → { pull: LocalModelPullDto } (runs in the
 *   background; poll GET /api/local-ai for progress)
 * POST /api/local-ai/use (owner) { url?, model, makeDefault? } → { provider: ProviderDto,
 *   settings: SettingsDto } (adds or updates the Ollama provider with that model; makeDefault
 *   sets it as the instance default model, which crew without a working model fall back to)
 */

export interface ModelOption {
  /** `provider/model-id`, the form crew.yaml uses. */
  ref: string;
  provider: string;
  id: string;
  name: string;
  /** Credentials are configured so this model can actually be called. */
  available: boolean;
  /** The model can look at images (photos in chat). */
  images: boolean;
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
  /** What runs it: Shipmate's own harness (pi) or the official Claude Code CLI. */
  backend: "pi" | "claude-code-cli";
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
  /** Pinned conversations come first in the list. */
  pinned: boolean;
  /** The latest thing said ("You: …" for the person's own words); only in the list. */
  preview: string | null;
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

/** GET /api/conversations → { conversations: ConversationDto[] } pinned first, then newest first */
/**
 * POST /api/conversations { kind?, crewSlug?, reuse? } → { conversation }
 * With `reuse`, a direct chat reopens the person's latest one with that crew member.
 */
/**
 * POST /api/conversations/:id/reset → { message }: the crew start afresh (they forget the chat
 * so far); the messages stay, below a divider message with meta { sessionReset: true }.
 */
/** PATCH /api/conversations/:id { title?, pinned? } → { conversation } */
/**
 * GET /api/conversations/search?q=<words>&limit=<n> → { results: ConversationSearchResultDto[] }
 * Full-text search over the caller's own conversations (every surface), best match first.
 * `q` takes web-search syntax: words, "exact phrases", -excluded, or.
 */
export interface ConversationSearchResultDto {
  conversation: ConversationDto;
  /** The title contains the search text. */
  titleMatch: boolean;
  /** Up to three matching messages, best first. */
  matches: Array<{
    messageId: string;
    /** A short excerpt; matched words are wrapped in SEARCH_MARK (search.ts). */
    snippet: string;
    author: string;
    createdAt: string;
  }>;
}
/** DELETE /api/conversations/:id → { ok: true } */
/** GET /api/conversations/:id/messages → { messages: MessageDto[] } oldest first */

// ---------- usage ----------

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Real API spend. Calls covered by a Claude or ChatGPT subscription add nothing here. */
  costMicroUsd: number;
  /** Calls that ran on a subscription instead of an API key. */
  subscriptionCalls: number;
  /**
   * Estimate of what the subscription calls would have cost at API prices (the "saved by your
   * subscription" figure). Not spend, and never counted towards caps.
   */
  apiEquivalentMicroUsd: number;
  /**
   * How long the model took to answer, averaged and at the 95th percentile, in ms. Null when no
   * call in the group has a recorded response time (calls from before it was recorded).
   */
  avgResponseMs: number | null;
  p95ResponseMs: number | null;
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
  byWatch: Array<UsageTotals & { watchId: string; name: string; capCents: number | null }>;
  /** One entry per UTC day of the month up to today, zeros included (phase 4). */
  daily: Array<{
    date: string;
    costMicroUsd: number;
    /** Subscription calls priced at API rates (an estimate, not spend). */
    apiEquivalentMicroUsd: number;
    calls: number;
    /** Input plus output tokens. */
    tokens: number;
    avgResponseMs: number | null;
  }>;
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
  /**
   * Model that looks at photos when a crew member's own model cannot; "" picks one
   * automatically (a vision-capable model from the same provider if there is one).
   */
  visionModel: string;
}
/**
 * GET /api/settings → SettingsDto.
 * PUT /api/settings (owner) Partial<captainName, defaultModel, visionModel> → SettingsDto
 */

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
  | { kind: "after"; routineId: string }
  /**
   * A GitHub event on a Shipyard project, through its signed webhook (see GITHUB_WATCH_EVENTS).
   * The run works in that project's workspace.
   */
  | { kind: "github"; projectId: string; events: GitHubWatchEvent[] };

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
/** A ready-made watch the Watches page offers with one click, e.g. the daily briefing. */
export interface WatchTemplateDto {
  id: string;
  name: string;
  description: string;
  /** Suggested crew member: the best fit aboard and visible to the caller. */
  crewSlug: string;
  /** Suggested schedule; the page lets the person change the time. */
  cron: string;
  prompt: string;
}
/** GET /api/watches/templates → { templates: WatchTemplateDto[] } */

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
  /** Set for servers that sign in through Shipmate with the owner's own Google OAuth client. */
  google: McpGoogleDto | null;
}
export interface McpGoogleDto {
  /** Paste into the OAuth client's "Authorized redirect URIs" in Google Cloud. */
  redirectUri: string;
  /**
   * The redirect is localhost (Google rejects this instance's address, or it is localhost), so
   * from another device the person pastes the address they land on back into Shipmate.
   */
  pasteBack: boolean;
  signedIn: boolean;
  email: string | null;
  /** Signed in with a client that is no longer the saved one: sign in again. */
  stale: boolean;
}
/**
 * GET /api/mcp → { servers: McpServerDto[] } (any signed-in user)
 * POST /api/mcp/:id/install (owner) → { server }   DELETE /api/mcp/:id (owner) → uninstall
 *   (custom servers are removed; catalog ones are marked not installed)
 * PUT /api/mcp/:id/secrets (owner) { values: Record<env, string> } → { server } ("" clears one)
 * PUT /api/mcp/:id/crews (admin) { crews: string[] } → { server } (edits each crew.yaml mcp list)
 * POST /api/mcp/custom (owner) CreateCustomMcpRequest → { server }
 * POST /api/mcp/google/start (owner) → { url } (send the browser there)
 * GET /api/mcp/google/callback → redirects to /#/mcp?google=ok|<error>
 * POST /api/mcp/google/finish (owner) { url } → { server } (the pasted landing address)
 * DELETE /api/mcp/google (owner) → { server } (signs out)
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
  /** Where sandboxes run, e.g. "unix:///var/run/docker.sock" or "tcp://nas.lan:2376 (TLS)". */
  endpoint: string;
}
/**
 * Where the Shipyard starts sandboxes (owner only). The environment (DOCKER_HOST,
 * DOCKER_TLS_VERIFY, DOCKER_CERT_PATH, DOCKER_SOCKET) gives the default; the owner can
 * override it here. TLS material is stored encrypted and never returned.
 */
export interface SandboxEndpointDto {
  /** "env": the server environment decides; "socket" / "tcp": set here by the owner. */
  mode: "env" | "socket" | "tcp";
  /** For socket mode: Docker's /var/run/docker.sock or rootless Podman's podman.sock. */
  socketPath: string | null;
  /** For tcp mode: "tcp://host:port". */
  host: string | null;
  /** Which TLS files are stored for tcp mode. */
  tls: { ca: boolean; cert: boolean; key: boolean };
  /** The workspaces folder as the sandbox host sees it (remote hosts, or a different mount). */
  workspacesPath: string | null;
  /** What is in effect now, described without secrets. */
  effective: string;
  /** What the environment alone would give. */
  fromEnv: string;
}
/** PUT /api/shipyard/sandbox. PEM fields: omit to keep, "" to clear. */
export interface UpdateSandboxEndpointRequest {
  mode: "env" | "socket" | "tcp";
  socketPath?: string;
  host?: string;
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  workspacesPath?: string;
}
export interface SandboxCheckDto {
  ok: boolean;
  endpoint: string;
  /** "Docker 27.3.1" or "Podman 5.2.0" when reachable. */
  engine: string | null;
  error: string | null;
  /** Things that work but deserve a second look (no TLS, no workspaces path). */
  warnings: string[];
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
  /** Last signed delivery from GitHub; null = never, so Shipmate polls instead. */
  webhookLastDeliveryAt: string | null;
  /** Crew member who reviews job PRs before they are marked ready; null = no review. */
  reviewerSlug: string | null;
  /** Issues given this label on GitHub become jobs (null = off). */
  triggerLabel: string | null;
  /** Issues assigned to this GitHub login become jobs (null = off). */
  triggerAssignee: string | null;
  /** Who automatic jobs run as. */
  triggerUser: { id: string; name: string } | null;
  /** Fix attempts for failing CI before a job gives up. */
  maxFixAttempts: number;
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
/**
 * `token: ""` clears the stored token. Job settings (admin): `reviewerSlug: null` turns review
 * off; empty trigger values turn that trigger off. Saving a trigger makes the saver the user
 * automatic jobs run as.
 */
export type UpdateProjectRequest = Partial<Omit<CreateProjectRequest, "provider">> & {
  reviewerSlug?: string | null;
  triggerLabel?: string;
  triggerAssignee?: string;
  maxFixAttempts?: number;
};
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
/**
 * An issue-to-PR job: a crew member works an issue on a branch, opens a draft PR, follows CI
 * and fixes failures up to a limit; an optional reviewer reviews it before it is marked ready.
 */
export type ShipyardJobStatus =
  | "working"
  | "pr_open"
  | "ci_running"
  | "ci_failed"
  | "reviewing"
  | "addressing_review"
  | "needs_input"
  | "ready"
  | "gave_up"
  | "merged"
  | "closed"
  | "cancelled";
export interface ShipyardJobDto {
  id: string;
  projectId: string;
  issue: { number: number; title: string; url: string | null };
  status: ShipyardJobStatus;
  source: "manual" | "label" | "assignee";
  crewSlug: string;
  branch: string | null;
  pr: { number: number; url: string } | null;
  attempts: number;
  maxAttempts: number;
  reviewRounds: number;
  reviewVerdict: "approve" | "changes_requested" | null;
  detail: string | null;
  user: { id: string; name: string };
  /** Only for the person the job runs as (conversations are private). */
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
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
 * GET /api/shipyard/projects/:id/jobs → { jobs: ShipyardJobDto[] } newest first
 * POST /api/shipyard/projects/:id/jobs { issue: number } → { job } (assign an issue)
 * POST /api/shipyard/jobs/:jobId/cancel → { job } ; POST /api/shipyard/jobs/:jobId/retry → { job }
 *   (the person the job runs as, or an admin)
 * POST /api/shipyard/projects/:id/webhook-secret (admin) → { project } (a new secret)
 * GET /api/shipyard/sandbox (owner) → { sandbox: SandboxEndpointDto }
 * PUT /api/shipyard/sandbox (owner) UpdateSandboxEndpointRequest → { sandbox }
 * POST /api/shipyard/sandbox/test (owner) UpdateSandboxEndpointRequest → { check: SandboxCheckDto }
 *   (tries the given settings without saving them; omitted TLS files use the stored ones)
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
  /**
   * Keep this many most recent scheduled backups; older scheduled ones are deleted. Manual
   * and CLI backups stay until someone deletes them.
   */
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

// ---------- health and updates ----------

export type HealthStatus = "ok" | "warn" | "fail";

export interface HealthCheckDto {
  /** Stable id, e.g. "database", "provider:<id>", "bridge:discord". */
  id: string;
  /** Database | Models | Chat bridges | Shipyard | Storage | Web address */
  group: string;
  name: string;
  status: HealthStatus;
  /** What was found, in plain words. */
  detail: string;
  /** What to do about a warning or failure; null when ok. */
  hint: string | null;
}

export interface ReleaseDto {
  /** Semver without the leading v, e.g. "1.1.0". */
  version: string;
  name: string;
  /** Release notes on GitHub. */
  url: string;
  publishedAt: string | null;
}

export interface ReleaseCheckDto {
  /** False when SHIPMATE_UPDATE_CHECK=off (offline installs). */
  enabled: boolean;
  latest: ReleaseDto | null;
  /** The latest release is newer than the running version. */
  updateAvailable: boolean;
  checkedAt: string | null;
  /** Why the check failed (offline, rate limited); the rest of the page still works. */
  error: string | null;
}

export interface UpdatePlanDto {
  /** The Update button can run: the Docker socket is there and the image tag can move. */
  oneClick: boolean;
  /** Why (or why not), in plain words. */
  reason: string;
  /** Shipmate's own container and image, when it runs in Docker and can see itself. */
  container: string | null;
  image: string | null;
  /** The helper image the one-click update runs (a one-shot Watchtower). */
  updaterImage: string;
  /** Commands to update by hand, ready to copy. */
  commands: string[];
}

export interface HealthDto {
  version: string;
  release: ReleaseCheckDto;
  checks: HealthCheckDto[];
  update: UpdatePlanDto;
  checkedAt: string;
}
/**
 * GET /api/health (admin) → { health: HealthDto } (?refresh=1 rechecks GitHub releases now;
 *   otherwise the release check is cached for a few hours). No check makes a paid model call.
 * POST /api/health/update (owner) { confirm: true } → { started: true, helper: string }
 *   Starts a short-lived helper container that pulls Shipmate's image and recreates its
 *   container with the same settings; Shipmate restarts. 409 when one-click is not possible.
 * GET /healthz (no sign-in) → { ok: true, version } for Docker healthchecks.
 */

// ---------- Telegram and Slack bridges (phase 5) ----------

/** What POST /api/telegram/link and POST /api/slack/link return; same shape as Discord's. */
export type BridgeLinkCode = DiscordLinkCode;

export interface TelegramChatDto {
  /** Telegram chat id (negative for groups). */
  chatId: string;
  title: string | null;
  crewSlug: string;
  crewName: string;
}
/** A chat the bot heard from that is not mapped yet, so an admin can pick it. */
export interface TelegramSeenChatDto {
  chatId: string;
  title: string;
  kind: "private" | "group" | "supergroup" | "channel";
}
export interface TelegramStatusDto {
  /** A bot token is stored. */
  configured: boolean;
  /** Long polling is running right now. */
  connected: boolean;
  /** The bot's @username, once connected. */
  botUsername: string | null;
  /** https://t.me/<botUsername> */
  botUrl: string | null;
  error: string | null;
  /** Private chats with the bot that are not mapped go to the Captain. */
  chats: TelegramChatDto[];
  seenChats: TelegramSeenChatDto[];
}
/**
 * One Telegram bot per instance, over long polling (no public URL needed). A Telegram bot has
 * one name, so each reply starts with the crew member's name. Each chat (group or DM) is mapped
 * to one crew member; unmapped DMs go to the Captain. People link their Telegram account with
 * a code (`/link 123456` to the bot); messages from unlinked accounts get a hint and never run.
 * Conversations use surface "telegram", one per chat and person.
 *
 * GET /api/telegram → { telegram: TelegramStatusDto } (any signed-in user)
 * PUT /api/telegram (owner) { botToken: string } → { telegram } (reconnects)
 * DELETE /api/telegram (owner) → { ok: true } (stops polling and forgets the token)
 * PUT /api/telegram/chats/:chatId (admin) { crewSlug: string | null }
 *   → { telegram } (map a chat to a crew member, or null to unmap)
 * POST /api/telegram/link → BridgeLinkCode   DELETE /api/telegram/link → { ok: true }
 */

export interface SlackChannelDto {
  crewSlug: string;
  crewName: string;
  /** Null until bound. */
  channelId: string | null;
  channelName: string | null;
}
export interface SlackStatusDto {
  /** Both the bot token and the app-level token are stored. */
  configured: boolean;
  /** Which tokens are stored (never their values). */
  hasBotToken: boolean;
  hasAppToken: boolean;
  /** The Socket Mode connection is open right now. */
  connected: boolean;
  teamId: string | null;
  teamName: string | null;
  botUserId: string | null;
  error: string | null;
  channels: SlackChannelDto[];
}
/**
 * One Slack app per instance over Socket Mode (no public URL needed). Each crew member is bound
 * to an existing channel and posts there with its own name and icon (chat:write.customize).
 * Direct messages to the app go to the Captain. People link their Slack account with a code
 * (`/shipmate link 123456`, or `!link 123456` in a crew channel). Surface "slack".
 *
 * GET /api/slack → { slack: SlackStatusDto } (any signed-in user)
 * PUT /api/slack (owner) { botToken?: string, appToken?: string } → { slack } (reconnects)
 * DELETE /api/slack (owner) → { ok: true } (disconnects and forgets both tokens)
 * PUT /api/slack/channels/:slug (admin) { channelId: string | null } → { slack }
 * POST /api/slack/link → BridgeLinkCode   DELETE /api/slack/link → { ok: true }
 */

// ---------- ChatGPT plan: Sign in with ChatGPT (phase 5) ----------

/** A sign-in that was started and is waiting for the owner to finish it in their browser. */
export interface ChatGptPendingSignInDto {
  /** Open this in a browser and sign in with the ChatGPT account whose plan should be used. */
  authorizeUrl: string;
  /**
   * Where OpenAI sends the browser afterwards (a localhost address). Unless Shipmate runs on
   * the same computer as the browser, that page will not load: copy the full address from the
   * address bar and paste it into Shipmate.
   */
  redirectUri: string;
  startedAt: string;
  /** The pending sign-in is dropped after this time; start again. */
  expiresAt: string;
}
export interface ChatGptStatusDto {
  signedIn: boolean;
  /** From the access token's claims when present; display only. */
  email: string | null;
  /** ChatGPT plan type ("plus", "pro", ...) when present. */
  plan: string | null;
  signedInAt: string | null;
  /** When the current access token expires. It is renewed on demand, never on a timer. */
  accessExpiresAt: string | null;
  /** The pi provider id model refs use (`chatgpt/<model>`). */
  providerId: string;
  /** Model refs crew can pick while signed in. */
  models: string[];
  pending: ChatGptPendingSignInDto | null;
  /** Last refresh failure, e.g. access was revoked; sign in again to fix. */
  lastError: string | null;
}
/**
 * Usage counts against the signed-in person's ChatGPT plan. Tokens are held only on the
 * server: the refresh token is encrypted in the secrets vault and no endpoint returns any token.
 * Access tokens are renewed on demand right before a model call that needs one (single-flight),
 * never by a background timer.
 *
 * GET /api/providers/chatgpt (owner) → { chatgpt: ChatGptStatusDto }
 * POST /api/providers/chatgpt/start (owner) → { chatgpt } with `pending` set (a new start
 *   replaces an unfinished one)
 * POST /api/providers/chatgpt/complete (owner) { callbackUrl } → { chatgpt }. callbackUrl is the
 *   full address the browser landed on (http://127.0.0.1:1455/auth/callback?code=…&state=…).
 * DELETE /api/providers/chatgpt/start (owner) → { chatgpt } (cancels a pending sign-in)
 * DELETE /api/providers/chatgpt (owner) → { chatgpt } (signs out: deletes the stored tokens)
 * Models appear in GET /api/models as `chatgpt/<id>` while signed in.
 */
export interface CompleteChatGptSignInRequest {
  callbackUrl: string;
}

// ---------- Claude subscription: the Claude Code CLI backend (phase 5) ----------

/**
 * A crew member with `backend: claude-code-cli` in crew.yaml answers through the unmodified
 * official `claude` binary that the user signed in with their own Claude account. Shipmate never
 * reads, stores or forwards that login (it only asks `claude auth status`), offers no Claude.ai
 * sign-in of its own and does no keep-alive pinging (§12). Optional `cli: { model, allowedTools,
 * permissionMode }` in crew.yaml; permissionMode defaults to `dontAsk` (tools not in
 * allowedTools are refused, since nobody can answer the CLI's own prompts).
 */
export interface ClaudeCliStatusDto {
  installed: boolean;
  version: string | null;
  /** From `claude auth status` (exit code and its logged-in flag) only. */
  signedIn: boolean;
  /** As the CLI reports it, e.g. "claude.ai" or "oauth_token"; null when unknown. */
  authMethod: string | null;
  /** CLAUDE_CONFIG_DIR, where the CLI keeps its own login (the image uses /data/claude). */
  configDir: string;
  /** Plain-text setup instructions (sign in once with `docker exec -it shipmate claude`). */
  docs: string;
}
/** GET /api/claude-cli (admin) → { claudeCli: ClaudeCliStatusDto } */

// ---------- starter crew (everyday life) ----------

/** A ready-made crew member from templates/crew/<slug> with its opt-in starter watch. */
export interface StarterCrewDto {
  slug: string;
  name: string;
  role: string;
  /** One line for the picker. */
  blurb: string;
  /** Whether it suits home life, work or both; the setup guide suggests the ones that match. */
  uses: Array<"home" | "work">;
  /** MCP servers from the catalog it is set up with. */
  mcp: string[];
  /** The watch it comes with; created paused, so nothing runs until someone turns it on. */
  watch: { name: string; cron: string; prompt: string } | null;
  /** A crew member with this slug is already aboard (or retired). */
  installed: boolean;
}
/**
 * GET /api/crew/starters → { starters: StarterCrewDto[] }
 * POST /api/crew/starters (admin) InstallStartersRequest → InstallStartersResponse. Crew get the
 *   instance's default model; catalog MCP servers they use are installed when the caller is the
 *   owner; starter watches are created paused and owned by the caller.
 */
export interface InstallStartersRequest {
  slugs: string[];
  /** Create each one's starter watch, paused (default true). */
  watches?: boolean;
  /** IANA timezone for the starter watches' schedules, e.g. the browser's. */
  timezone?: string;
}
export interface InstallStartersResponse {
  crew: CrewDto[];
  watches: WatchDto[];
  /** Plain-language follow-ups, e.g. an MCP server that still needs a key. */
  notes: string[];
}

// ---------- shared lists (everyday life) ----------

export type ListKind = "grocery" | "todo" | "packing" | "bills" | "other";

export interface ListItemDto {
  id: string;
  text: string;
  checked: boolean;
  /** YYYY-MM-DD, e.g. when a bill is due; null when not set. */
  dueOn: string | null;
  note: string | null;
  position: number;
  /** Who added it: a person's name, or "Galley for Addison" when a crew member did. */
  addedBy: string | null;
  checkedAt: string | null;
  createdAt: string;
}
export interface ListDto {
  id: string;
  name: string;
  kind: ListKind;
  /** Shared lists are for everyone on the instance; private ones only for their owner. */
  shared: boolean;
  owner: { id: string; name: string } | null;
  /** Who made it; they (or an admin) may delete a shared list. */
  createdById: string | null;
  /** Items not checked off yet, and all items. */
  openCount: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface ListDetailDto extends ListDto {
  /** Unchecked first, each in list order. */
  items: ListItemDto[];
}
/**
 * Lists are real objects the household and the crew both read and write; crew use the
 * show_lists, read_list, add_to_list, check_list_items, remove_from_list and create_list tools,
 * on behalf of the person they are working for. Changes arrive live as `list_changed` events.
 *
 * GET /api/lists → { lists: ListDto[] } (shared lists and the caller's private ones)
 * POST /api/lists CreateListRequest → { list: ListDetailDto }
 * GET /api/lists/:id → { list }   PATCH /api/lists/:id { name?, kind? } → { list }
 * DELETE /api/lists/:id → { ok: true } (a shared list: its creator or an admin)
 * POST /api/lists/:id/items { text, dueOn?, note? } → { list }
 * PATCH /api/lists/:id/items/:itemId UpdateListItemRequest → { list }
 * DELETE /api/lists/:id/items/:itemId → { list }
 * POST /api/lists/:id/clear → { list } (removes checked items)
 */
export interface CreateListRequest {
  name: string;
  kind?: ListKind;
  /** Default true; false makes it private to the caller. */
  shared?: boolean;
}
export interface UpdateListItemRequest {
  text?: string;
  checked?: boolean;
  dueOn?: string | null;
  note?: string | null;
  position?: number;
}

// ---------- household profiles (everyday life) ----------

export interface ProfileDto extends PersonProfile {
  /**
   * Crew working for other people in the household may read it too (e.g. the Galley planning
   * dinner for everyone). Off by default; the person's own crew always see it.
   */
  shared: boolean;
  updatedAt: string | null;
}
export interface HouseholdDto extends HouseholdFacts {
  updatedAt: string | null;
}
/**
 * Every crew member gets the household facts and the profile of the person it is working for in
 * its context (compactly), and `read_profiles` for the full text including shared profiles.
 *
 * GET /api/profile → { profile: ProfileDto, household: HouseholdDto } (the caller's own)
 * PUT /api/profile Partial<PersonProfile & { shared }> → { profile }
 * PUT /api/household (owner, admin) Partial<HouseholdFacts> → { household }
 */
export type UpdateProfileRequest = Partial<PersonProfile> & { shared?: boolean };
export type UpdateHouseholdRequest = Partial<HouseholdFacts>;

// ---------- crew import and export (everyday life) ----------

/**
 * One crew member as a single shareable file (`<slug>.shipmate-crew.json`): crew.yaml, CREW.md
 * and its active skills. Never memory, sessions, approvals ("allow"), spend caps or secrets.
 */
export interface CrewBundle {
  format: "shipmate-crew";
  version: 1;
  /** Suggested slug; the importer may pick another. */
  slug: string;
  /** crew.yaml text. */
  manifest: string;
  /** CREW.md text. */
  persona: string;
  /** Each skill's SKILL.md (only the SKILL.md file; extra skill files are not shared). */
  skills: Array<{ name: string; content: string }>;
  exportedAt?: string;
}
export interface CrewImportPreviewDto {
  /** The cleaned bundle to send back with POST /api/crew/import. */
  bundle: CrewBundle;
  name: string;
  role: string;
  /** The model it will get here (its own when available, else the default). */
  model: string;
  /** The bundle asked for a model this instance cannot use, so the default replaces it. */
  modelReplaced: string | null;
  backend: "pi" | "claude-code-cli";
  tools: string[];
  mcp: Array<{ id: string; known: boolean; installed: boolean }>;
  skills: Array<{ name: string; description: string }>;
  persona: string;
  /** A free slug: the bundle's, or with a number added when that one is taken. */
  slug: string;
  /** Things to look at before importing, in plain words. */
  warnings: string[];
}
/**
 * GET /api/crew/:slug/export → the CrewBundle as a JSON download. Header
 *   X-Shipmate-Redacted: <n> counts values that looked like keys or tokens and were replaced.
 * POST /api/crew/import/preview (admin) { text } | { url } → { preview: CrewImportPreviewDto }
 *   `text` is the file's contents; `url` must be https on a public host (at most 512 KB).
 * POST /api/crew/import (admin) { bundle, slug } → { crew: CrewDetailDto } (pending review; its
 *   skills wait for approval on the Skills page)
 */
export interface CrewImportRequest {
  bundle: CrewBundle;
  slug: string;
}

// ---------- WebSocket: /api/ws ----------

export type ClientEvent =
  /** `attachments`: ids of files uploaded for this message (see phone.ts). */
  | { type: "send"; conversationId: string; text: string; attachments?: string[] | undefined }
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
  | { type: "watch_run"; watchName: string; run: WatchRunDto }
  /** A list or its items changed (here, on another device, or by a crew member); refetch it. */
  | { type: "list_changed"; listId: string; deleted?: boolean }
  /** An issue-to-PR job changed; sent to everyone (the Shipyard is shared). Refetch its list. */
  | { type: "shipyard_job"; projectId: string; jobId: string; status: ShipyardJobStatus };
