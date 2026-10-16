import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SELF_HOSTED_KINDS } from "./kinds.js";

/** A configured provider with its key already decrypted from the vault. */
export interface ProviderRecord {
  id: string;
  kind: string;
  label: string;
  baseUrl: string | null;
  apiKey: string | null;
  models: string[];
  enabled: boolean;
  /** Context size the owner set for every model on this provider; null means use the server's. */
  contextWindow?: number | null;
  /** Context size per model id as the server reported it. */
  modelContexts?: Record<string, number>;
}

/**
 * Context size assumed when a self-hosted server does not say. Small on purpose: claiming more
 * than the server holds makes it cut the start of the chat (the instructions) without saying so.
 */
export const DEFAULT_LOCAL_CONTEXT = 32768;

/** The context size pi is told a self-hosted model has: the owner's, the server's, or the default. */
export function localContextWindow(
  record: Pick<ProviderRecord, "contextWindow" | "modelContexts">,
  model: string,
): number {
  return record.contextWindow || record.modelContexts?.[model] || DEFAULT_LOCAL_CONTEXT;
}

/** Room for one reply: a quarter of the context, at most 8K, so the chat itself keeps the rest. */
export function localMaxTokens(contextWindow: number): number {
  return Math.min(8192, Math.max(256, Math.floor(contextWindow / 4)));
}

/** Built-in pi provider ids for the API-key kinds. */
const BUILTIN: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  xai: "xai",
  google: "google",
  openrouter: "openrouter",
};

/**
 * The pi provider id a record maps to, which is the first half of a `provider/model` ref in
 * crew.yaml. Ollama is `ollama`; an OpenAI-compatible server is named after its label.
 */
export function piProviderId(record: Pick<ProviderRecord, "kind" | "label">): string | undefined {
  if (record.kind in BUILTIN) return BUILTIN[record.kind];
  if (record.kind === "ollama") return "ollama";
  if (record.kind === "openai-compatible") return slugify(record.label) || "local";
  return undefined;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Keeps a pi ModelRuntime in step with the providers table: API keys become runtime keys
 * (never written to pi's auth.json), self-hosted servers become registered providers.
 */
export class ProviderBinder {
  #applied = new Map<string, { kind: "key" | "registered" }>();

  constructor(private readonly runtime: ModelRuntime) {}

  async sync(records: ProviderRecord[]): Promise<void> {
    const wanted = new Map<string, ProviderRecord>();
    for (const r of records) {
      const pid = piProviderId(r);
      if (!pid || !r.enabled) continue;
      if (!SELF_HOSTED_KINDS.includes(r.kind) && !r.apiKey) continue;
      wanted.set(pid, r);
    }
    for (const [pid, applied] of this.#applied) {
      if (wanted.has(pid)) continue;
      if (applied.kind === "key") await this.runtime.removeRuntimeApiKey(pid);
      else this.runtime.unregisterProvider(pid);
      this.#applied.delete(pid);
    }
    for (const [pid, r] of wanted) {
      if (SELF_HOSTED_KINDS.includes(r.kind)) {
        if (this.#applied.has(pid)) this.runtime.unregisterProvider(pid);
        this.runtime.registerProvider(pid, {
          name: r.label,
          baseUrl: normalizeBaseUrl(r.baseUrl ?? defaultBaseUrl(r.kind)),
          api: "openai-completions",
          // Ollama ignores the key; a dummy one marks the provider as configured for pi.
          apiKey: r.apiKey || "none",
          models: r.models.map((id) => {
            const contextWindow = localContextWindow(r, id);
            return {
              id,
              name: id,
              input: ["text"],
              reasoning: false,
              contextWindow,
              maxTokens: localMaxTokens(contextWindow),
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
          }),
        });
        this.#applied.set(pid, { kind: "registered" });
      } else if (r.apiKey) {
        await this.runtime.setRuntimeApiKey(pid, r.apiKey);
        this.#applied.set(pid, { kind: "key" });
      }
    }
  }
}

export function defaultBaseUrl(kind: string): string {
  return kind === "ollama" ? "http://localhost:11434/v1" : "http://localhost:8000/v1";
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Lists the models an OpenAI-compatible server offers (`GET <baseUrl>/models`). */
export async function probeModels(
  baseUrl: string,
  apiKey?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  return (await probeServer(baseUrl, apiKey, fetchImpl)).models;
}

export interface ServerProbe {
  models: string[];
  /** Context size per model id, for the models the server said it for. */
  contexts: Record<string, number>;
}

/**
 * Lists a self-hosted server's models and, where it says, how much context each holds. The
 * OpenAI `/models` list has no standard field for it, so this reads the ones servers use:
 * llama.cpp (`meta.n_ctx`), vLLM (`max_model_len`), LM Studio and OpenRouter-style servers
 * (`loaded_context_length`, `context_length`). When the list says nothing it asks llama.cpp's
 * `/props`, LM Studio's `/api/v0/models` and Ollama's `/api/ps`, each optional.
 */
export async function probeServer(
  baseUrl: string,
  apiKey?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerProbe> {
  const base = normalizeBaseUrl(baseUrl);
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetchImpl(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${baseUrl}/models`);
  const body = (await res.json()) as { data?: unknown[]; models?: unknown[] };
  const contexts: Record<string, number> = {};
  const trained: Record<string, number> = {};
  const ids: string[] = [];
  for (const m of [...(body.data ?? []), ...(body.models ?? [])]) {
    const id = modelId(m);
    if (!id) continue;
    ids.push(id);
    const ctx = contextOf(m);
    if (ctx) contexts[id] = ctx;
    const train = trainedContextOf(m);
    if (train) trained[id] = train;
  }
  const models = [...new Set(ids)].sort();
  const missing = models.filter((id) => !contexts[id]);
  if (missing.length) {
    const extra = await probeExtraContexts(base, headers, fetchImpl);
    for (const id of missing) {
      // The most a model was trained on comes last: llama.cpp often loads it with less.
      const ctx =
        extra.byModel[id] ??
        extra.byModel[id.replace(/:latest$/, "")] ??
        extra.server ??
        trained[id];
      if (ctx) contexts[id] = ctx;
    }
  }
  return { models, contexts };
}

function modelId(m: unknown): string | undefined {
  if (!m || typeof m !== "object") return undefined;
  const { id, name } = m as { id?: unknown; name?: unknown };
  const value = typeof id === "string" ? id : typeof name === "string" ? name : undefined;
  return value || undefined;
}

/** A positive whole number of tokens, or undefined. */
function tokens(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The context size a model entry reports; the loaded size wins over the most it could take. */
export function contextOf(m: unknown): number | undefined {
  if (!m || typeof m !== "object") return undefined;
  const o = m as Record<string, unknown>;
  const meta = (o.meta && typeof o.meta === "object" ? o.meta : {}) as Record<string, unknown>;
  return (
    tokens(meta.n_ctx) ??
    tokens(o.loaded_context_length) ??
    tokens(o.max_model_len) ??
    tokens(o.context_length) ??
    tokens(o.context_window) ??
    tokens(o.max_context_length)
  );
}

/** llama.cpp's training window: only a guess at what is loaded, so used after `/props`. */
function trainedContextOf(m: unknown): number | undefined {
  if (!m || typeof m !== "object") return undefined;
  const meta = (m as { meta?: unknown }).meta;
  return meta && typeof meta === "object"
    ? tokens((meta as Record<string, unknown>).n_ctx_train)
    : undefined;
}

/** Context sizes from servers' own endpoints. Every call is optional and quick to give up. */
async function probeExtraContexts(
  base: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ byModel: Record<string, number>; server?: number }> {
  const root = base.replace(/\/v1$/, "");
  const get = async (url: string): Promise<unknown> => {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) });
      return res.ok ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const [props, lmstudio, ollama] = await Promise.all([
    get(`${root}/props`),
    get(`${root}/api/v0/models`),
    get(`${root}/api/ps`),
  ]);
  const byModel: Record<string, number> = {};
  for (const list of [
    (lmstudio as { data?: unknown[] } | undefined)?.data,
    (ollama as { models?: unknown[] } | undefined)?.models,
  ]) {
    for (const m of Array.isArray(list) ? list : []) {
      const id = modelId(m);
      const ctx = contextOf(m);
      if (id && ctx) byModel[id] = ctx;
    }
  }
  const settings = (props as { default_generation_settings?: Record<string, unknown> } | undefined)
    ?.default_generation_settings;
  const server = tokens(settings?.n_ctx);
  return server ? { byModel, server } : { byModel };
}
