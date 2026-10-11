import type {
  ConversationDto,
  CreateCrewRequest,
  CreateProviderRequest,
  CreateUserRequest,
  CrewDetailDto,
  CrewDto,
  LoginRequest,
  MemoryEntryDto,
  MeResponse,
  MessageDto,
  ModelOption,
  ProviderDto,
  ProvidersResponse,
  SettingsDto,
  SetupRequest,
  UpdateCrewRequest,
  UpdateProviderRequest,
  UpdateUserRequest,
  UsageResponse,
  UserDto,
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
  listMessages: (id: string) =>
    request<{ messages: MessageDto[] }>("GET", `/api/conversations/${enc(id)}/messages`),

  // usage
  usage: (month: string, scope: "me" | "all") =>
    request<UsageResponse>("GET", `/api/usage?month=${enc(month)}&scope=${scope}`),

  // settings
  getSettings: () => request<SettingsDto>("GET", "/api/settings"),
  updateSettings: (body: Partial<Pick<SettingsDto, "captainName" | "defaultModel">>) =>
    request<SettingsDto>("PUT", "/api/settings", body),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
