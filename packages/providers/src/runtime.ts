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
          models: r.models.map((id) => ({
            id,
            name: id,
            input: ["text"],
            reasoning: false,
            contextWindow: 32768,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
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
  const res = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${baseUrl}/models`);
  const body = (await res.json()) as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ name?: unknown }>;
  };
  const ids = [
    ...(body.data ?? []).map((m) => m.id),
    ...(body.models ?? []).map((m) => m.name),
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}
