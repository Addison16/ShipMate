import type {
  ApprovalDecision,
  ApprovalDto,
  AuditEventDto,
  BridgeLinkCode,
  ConversationDto,
  ConversationSearchResultDto,
  CreateCrewRequest,
  CreateCustomMcpRequest,
  CreateListRequest,
  CreateProjectRequest,
  CreateProviderRequest,
  CreateSkillRequest,
  CreateUserRequest,
  CreateWatchRequest,
  CrewDetailDto,
  CrewDto,
  CrewImportPreviewDto,
  CrewImportRequest,
  DiscordLinkCode,
  DiscordStatusDto,
  HouseholdDto,
  InstallStartersRequest,
  InstallStartersResponse,
  HealthDto,
  IssueDto,
  ListDetailDto,
  ListDto,
  ListKind,
  LocalAiStatusDto,
  LocalModelPullDto,
  LoginRequest,
  McpServerDto,
  MemoryEntryDto,
  MeResponse,
  MessageDto,
  ModelOption,
  ProfileDto,
  ProjectDto,
  ProjectEventDto,
  ProviderDto,
  ProvidersResponse,
  PullRequestDto,
  SettingsDto,
  SetupRequest,
  ShipyardStatusDto,
  SkillDetailDto,
  SkillDto,
  SlackStatusDto,
  StarterCrewDto,
  StartFlowRequest,
  TelegramStatusDto,
  UpdateCrewRequest,
  UpdateHouseholdRequest,
  UpdateListItemRequest,
  UpdatePreferencesRequest,
  UpdateProfileRequest,
  UpdateProjectRequest,
  UpdateProviderRequest,
  UpdateUserRequest,
  UpdateWatchRequest,
  UsageResponse,
  UserDto,
  WatchDto,
  WatchRunDto,
  WatchTemplateDto,
} from "@shipmate/core";

/** An HTTP error from the server; `message` is the server's `{ error }` text when present. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "Cannot reach the Shipmate server.");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `${res.status} ${res.statusText || "Request failed"}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const enc = encodeURIComponent;
type Ok = { ok: true };

export const api = {
  // auth
  me: () => request<MeResponse>("GET", "/api/auth/me"),
  setup: (body: SetupRequest) => request<{ user: UserDto }>("POST", "/api/setup", body),
  login: (body: LoginRequest) => request<{ user: UserDto }>("POST", "/api/auth/login", body),
  updatePreferences: (body: UpdatePreferencesRequest) =>
    request<{ user: UserDto }>("PATCH", "/api/auth/preferences", body),
  logout: () => request<Ok>("POST", "/api/auth/logout"),

  // users
  listUsers: () => request<{ users: UserDto[] }>("GET", "/api/users"),
  createUser: (body: CreateUserRequest) => request<{ user: UserDto }>("POST", "/api/users", body),
  updateUser: (id: string, body: UpdateUserRequest) =>
    request<{ user: UserDto }>("PATCH", `/api/users/${enc(id)}`, body),
  deleteUser: (id: string) => request<Ok>("DELETE", `/api/users/${enc(id)}`),

  // providers and models
  listProviders: () => request<ProvidersResponse>("GET", "/api/providers"),
  createProvider: (body: CreateProviderRequest) =>
    request<{ provider: ProviderDto }>("POST", "/api/providers", body),
  updateProvider: (id: string, body: UpdateProviderRequest) =>
    request<{ provider: ProviderDto }>("PATCH", `/api/providers/${enc(id)}`, body),
  deleteProvider: (id: string) => request<Ok>("DELETE", `/api/providers/${enc(id)}`),
  probeProvider: (id: string) =>
    request<{ models: string[] }>("POST", `/api/providers/${enc(id)}/probe`),
  listModels: () => request<{ models: ModelOption[] }>("GET", "/api/models"),

  // local models (Ollama)
  localAi: (url?: string) =>
    request<{ localAi: LocalAiStatusDto }>("GET", `/api/local-ai${url ? `?url=${enc(url)}` : ""}`),
  pullLocalModel: (model: string, url?: string) =>
    request<{ pull: LocalModelPullDto }>("POST", "/api/local-ai/pull", {
      model,
      ...(url ? { url } : {}),
    }),
  setUpLocalModel: (body: { model: string; url?: string; makeDefault?: boolean }) =>
    request<{ provider: ProviderDto; settings: SettingsDto }>("POST", "/api/local-ai/use", body),

  // crew
  listCrew: (all = false) => request<{ crew: CrewDto[] }>("GET", `/api/crew${all ? "?all=1" : ""}`),
  getCrew: (slug: string) => request<{ crew: CrewDetailDto }>("GET", `/api/crew/${enc(slug)}`),
  createCrew: (body: CreateCrewRequest) =>
    request<{ crew: CrewDetailDto }>("POST", "/api/crew", body),
  updateCrew: (slug: string, body: UpdateCrewRequest) =>
    request<{ crew: CrewDetailDto }>("PUT", `/api/crew/${enc(slug)}`, body),
  approveCrew: (slug: string) =>
    request<{ crew: CrewDetailDto }>("POST", `/api/crew/${enc(slug)}/approve`),
  retireCrew: (slug: string) => request<Ok>("DELETE", `/api/crew/${enc(slug)}`),
  crewMemory: (slug: string) =>
    request<{ shared: MemoryEntryDto[]; mine: MemoryEntryDto[] }>(
      "GET",
      `/api/crew/${enc(slug)}/memory`,
    ),
  deleteMemory: (slug: string, scope: "shared" | "user", name: string) =>
    request<Ok>("DELETE", `/api/crew/${enc(slug)}/memory/${enc(scope)}/${enc(name)}`),
  previewCrewImport: (body: { text: string } | { url: string }) =>
    request<{ preview: CrewImportPreviewDto }>("POST", "/api/crew/import/preview", body),
  importCrew: (body: CrewImportRequest) =>
    request<{ crew: CrewDetailDto }>("POST", "/api/crew/import", body),
  listStarters: () => request<{ starters: StarterCrewDto[] }>("GET", "/api/crew/starters"),
  installStarters: (body: InstallStartersRequest) =>
    request<InstallStartersResponse>("POST", "/api/crew/starters", body),

  // conversations
  listConversations: () =>
    request<{ conversations: ConversationDto[] }>("GET", "/api/conversations"),
  createConversation: (body: { kind?: "bridge" | "direct"; crewSlug?: string }) =>
    request<{ conversation: ConversationDto }>("POST", "/api/conversations", body),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: ConversationDto }>("PATCH", `/api/conversations/${enc(id)}`, {
      title,
    }),
  deleteConversation: (id: string) => request<Ok>("DELETE", `/api/conversations/${enc(id)}`),
  pinConversation: (id: string, pinned: boolean) =>
    request<{ conversation: ConversationDto }>("PATCH", `/api/conversations/${enc(id)}`, {
      pinned,
    }),
  searchConversations: (q: string) =>
    request<{ results: ConversationSearchResultDto[] }>(
      "GET",
      `/api/conversations/search?q=${enc(q)}`,
    ),
  listMessages: (id: string) =>
    request<{ messages: MessageDto[] }>("GET", `/api/conversations/${enc(id)}/messages`),

  // lists
  listLists: () => request<{ lists: ListDto[] }>("GET", "/api/lists"),
  createList: (body: CreateListRequest) =>
    request<{ list: ListDetailDto }>("POST", "/api/lists", body),
  getList: (id: string) => request<{ list: ListDetailDto }>("GET", `/api/lists/${enc(id)}`),
  updateList: (id: string, body: { name?: string; kind?: ListKind }) =>
    request<{ list: ListDetailDto }>("PATCH", `/api/lists/${enc(id)}`, body),
  deleteList: (id: string) => request<Ok>("DELETE", `/api/lists/${enc(id)}`),
  addListItem: (id: string, body: { text: string; dueOn?: string | null; note?: string | null }) =>
    request<{ list: ListDetailDto }>("POST", `/api/lists/${enc(id)}/items`, body),
  updateListItem: (id: string, itemId: string, body: UpdateListItemRequest) =>
    request<{ list: ListDetailDto }>("PATCH", `/api/lists/${enc(id)}/items/${enc(itemId)}`, body),
  deleteListItem: (id: string, itemId: string) =>
    request<{ list: ListDetailDto }>("DELETE", `/api/lists/${enc(id)}/items/${enc(itemId)}`),
  clearListChecked: (id: string) =>
    request<{ list: ListDetailDto }>("POST", `/api/lists/${enc(id)}/clear`),

  // household profiles
  getProfile: () =>
    request<{ profile: ProfileDto; household: HouseholdDto }>("GET", "/api/profile"),
  updateProfile: (body: UpdateProfileRequest) =>
    request<{ profile: ProfileDto }>("PUT", "/api/profile", body),
  updateHousehold: (body: UpdateHouseholdRequest) =>
    request<{ household: HouseholdDto }>("PUT", "/api/household", body),

  // usage
  usage: (month: string, scope: "me" | "all") =>
    request<UsageResponse>("GET", `/api/usage?month=${enc(month)}&scope=${scope}`),

  // health and updates
  health: (refresh = false) =>
    request<{ health: HealthDto }>("GET", `/api/health${refresh ? "?refresh=1" : ""}`),
  startUpdate: () =>
    request<{ started: true; helper: string }>("POST", "/api/health/update", { confirm: true }),
  meta: () => request<{ version: string }>("GET", "/api/meta"),

  // settings
  getSettings: () => request<SettingsDto>("GET", "/api/settings"),
  updateSettings: (body: Partial<Pick<SettingsDto, "captainName" | "defaultModel">>) =>
    request<SettingsDto>("PUT", "/api/settings", body),

  // skills
  listSkills: () => request<{ skills: SkillDto[] }>("GET", "/api/skills"),
  getSkill: (id: string) => request<{ skill: SkillDetailDto }>("GET", `/api/skills/${enc(id)}`),
  createSkill: (body: CreateSkillRequest) =>
    request<{ skill: SkillDetailDto }>("POST", "/api/skills", body),
  updateSkill: (id: string, content: string) =>
    request<{ skill: SkillDetailDto }>("PUT", `/api/skills/${enc(id)}`, { content }),
  approveSkill: (id: string) =>
    request<{ skill: SkillDetailDto }>("POST", `/api/skills/${enc(id)}/approve`),
  deleteSkill: (id: string) => request<Ok>("DELETE", `/api/skills/${enc(id)}`),

  // approvals and audit
  listApprovals: () => request<{ approvals: ApprovalDto[] }>("GET", "/api/approvals"),
  decideApproval: (id: string, decision: ApprovalDecision) =>
    request<Ok>("POST", `/api/approvals/${enc(id)}`, { decision }),
  audit: (q: { crew?: string; user?: string; before?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (q.crew) params.set("crew", q.crew);
    if (q.user) params.set("user", q.user);
    if (q.before) params.set("before", q.before);
    if (q.limit) params.set("limit", String(q.limit));
    const qs = params.toString();
    return request<{ events: AuditEventDto[] }>("GET", `/api/audit${qs ? `?${qs}` : ""}`);
  },

  // watches
  listWatches: () => request<{ watches: WatchDto[] }>("GET", "/api/watches"),
  watchTemplates: () => request<{ templates: WatchTemplateDto[] }>("GET", "/api/watches/templates"),
  createWatch: (body: CreateWatchRequest) =>
    request<{ watch: WatchDto }>("POST", "/api/watches", body),
  updateWatch: (id: string, body: UpdateWatchRequest) =>
    request<{ watch: WatchDto }>("PATCH", `/api/watches/${enc(id)}`, body),
  deleteWatch: (id: string) => request<Ok>("DELETE", `/api/watches/${enc(id)}`),
  runWatch: (id: string) => request<{ run: WatchRunDto }>("POST", `/api/watches/${enc(id)}/run`),
  watchRuns: (id: string, limit = 20) =>
    request<{ runs: WatchRunDto[] }>("GET", `/api/watches/${enc(id)}/runs?limit=${limit}`),

  // MCP servers
  listMcp: () => request<{ servers: McpServerDto[] }>("GET", "/api/mcp"),
  installMcp: (id: string) =>
    request<{ server: McpServerDto }>("POST", `/api/mcp/${enc(id)}/install`),
  uninstallMcp: (id: string) => request<Ok>("DELETE", `/api/mcp/${enc(id)}`),
  setMcpSecrets: (id: string, values: Record<string, string>) =>
    request<{ server: McpServerDto }>("PUT", `/api/mcp/${enc(id)}/secrets`, { values }),
  setMcpCrews: (id: string, crews: string[]) =>
    request<{ server: McpServerDto }>("PUT", `/api/mcp/${enc(id)}/crews`, { crews }),
  createCustomMcp: (body: CreateCustomMcpRequest) =>
    request<{ server: McpServerDto }>("POST", "/api/mcp/custom", body),

  // Discord bridge
  getDiscord: () => request<{ discord: DiscordStatusDto }>("GET", "/api/discord"),
  updateDiscord: (body: { botToken?: string; guildId?: string }) =>
    request<{ discord: DiscordStatusDto }>("PUT", "/api/discord", body),
  disconnectDiscord: () => request<Ok>("DELETE", "/api/discord"),
  syncDiscord: () => request<{ discord: DiscordStatusDto }>("POST", "/api/discord/sync"),
  bindDiscordChannel: (slug: string, channelId: string | null) =>
    request<{ discord: DiscordStatusDto }>("PUT", `/api/discord/channels/${enc(slug)}`, {
      channelId,
    }),
  createDiscordLink: () => request<DiscordLinkCode>("POST", "/api/discord/link"),
  unlinkDiscord: () => request<Ok>("DELETE", "/api/discord/link"),

  // Telegram and Slack bridges (phase 5)
  getTelegram: () => request<{ telegram: TelegramStatusDto }>("GET", "/api/telegram"),
  updateTelegram: (botToken: string) =>
    request<{ telegram: TelegramStatusDto }>("PUT", "/api/telegram", { botToken }),
  disconnectTelegram: () => request<Ok>("DELETE", "/api/telegram"),
  mapTelegramChat: (chatId: string, crewSlug: string | null) =>
    request<{ telegram: TelegramStatusDto }>("PUT", `/api/telegram/chats/${enc(chatId)}`, {
      crewSlug,
    }),
  createTelegramLink: () => request<BridgeLinkCode>("POST", "/api/telegram/link"),
  unlinkTelegram: () => request<Ok>("DELETE", "/api/telegram/link"),
  getSlack: () => request<{ slack: SlackStatusDto }>("GET", "/api/slack"),
  updateSlack: (body: { botToken?: string; appToken?: string }) =>
    request<{ slack: SlackStatusDto }>("PUT", "/api/slack", body),
  disconnectSlack: () => request<Ok>("DELETE", "/api/slack"),
  bindSlackChannel: (slug: string, channelId: string | null) =>
    request<{ slack: SlackStatusDto }>("PUT", `/api/slack/channels/${enc(slug)}`, { channelId }),
  createSlackLink: () => request<BridgeLinkCode>("POST", "/api/slack/link"),
  unlinkSlack: () => request<Ok>("DELETE", "/api/slack/link"),

  // Shipyard
  getShipyard: () =>
    request<{ status: ShipyardStatusDto; projects: ProjectDto[] }>("GET", "/api/shipyard"),
  createProject: (body: CreateProjectRequest) =>
    request<{ project: ProjectDto }>("POST", "/api/shipyard/projects", body),
  getProject: (id: string) =>
    request<{ project: ProjectDto }>("GET", `/api/shipyard/projects/${enc(id)}`),
  updateProject: (id: string, body: UpdateProjectRequest) =>
    request<{ project: ProjectDto }>("PATCH", `/api/shipyard/projects/${enc(id)}`, body),
  deleteProject: (id: string) => request<Ok>("DELETE", `/api/shipyard/projects/${enc(id)}`),
  cloneProject: (id: string) =>
    request<{ project: ProjectDto }>("POST", `/api/shipyard/projects/${enc(id)}/clone`),
  sandboxAction: (id: string, action: "start" | "stop" | "reset") =>
    request<{ project: ProjectDto }>("POST", `/api/shipyard/projects/${enc(id)}/sandbox`, {
      action,
    }),
  listPulls: (id: string, state: "open" | "closed" | "all" = "open") =>
    request<{ pulls: PullRequestDto[] }>(
      "GET",
      `/api/shipyard/projects/${enc(id)}/pulls?state=${state}`,
    ),
  listIssues: (id: string, state: "open" | "closed" | "all" = "open") =>
    request<{ issues: IssueDto[] }>(
      "GET",
      `/api/shipyard/projects/${enc(id)}/issues?state=${state}`,
    ),
  listProjectEvents: (id: string, limit = 50) =>
    request<{ events: ProjectEventDto[] }>(
      "GET",
      `/api/shipyard/projects/${enc(id)}/events?limit=${limit}`,
    ),
  startFlow: (id: string, body: StartFlowRequest) =>
    request<{ conversationId: string }>("POST", `/api/shipyard/projects/${enc(id)}/flows`, body),
  createProjectConversation: (id: string) =>
    request<{ conversation: ConversationDto }>(
      "POST",
      `/api/shipyard/projects/${enc(id)}/conversations`,
    ),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
