import type {
  LocalAiStatusDto,
  LocalModelDto,
  LocalModelPullDto,
  ProviderDto,
  RecommendedModelDto,
} from "@shipmate/core";
import { HttpError } from "../auth.js";
import type { ProviderService } from "./providers.js";
import type { SettingsService } from "./settings.js";

/** Where docker-compose's optional `ollama` service answers (profile local-ai). */
export const DEFAULT_OLLAMA_URL = "http://ollama:11434";

/**
 * Small models that run on an ordinary home server and can call tools, which crew need.
 * Sizes are Ollama's download sizes, rounded.
 */
export const RECOMMENDED_MODELS: RecommendedModelDto[] = [
  {
    name: "qwen3:4b",
    size: "2.5 GB",
    note: "A good first pick: small, quick, and handles tools well. About 4 GB of free memory.",
  },
  {
    name: "llama3.2:3b",
    size: "2.0 GB",
    note: "The lightest choice, for small machines. Simpler answers.",
  },
  {
    name: "qwen3:8b",
    size: "5.2 GB",
    note: "Noticeably better answers. Wants 8 GB or more of free memory.",
  },
  {
    name: "gpt-oss:20b",
    size: "14 GB",
    note: "The strongest here. Wants 16 GB of memory or a GPU.",
  },
];

/** Ollama model names: `name[:tag]`, optionally with a namespace (`user/name:tag`). */
export const MODEL_NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*(:[a-z0-9._-]+)?$/i;

/** How long a finished pull stays listed, so the page can show it completed. */
const KEEP_FINISHED_MS = 10 * 60_000;

interface Pull extends LocalModelPullDto {
  finishedAt: number | null;
  layers: Map<string, { total: number; completed: number }>;
}

/** "llama3.2" and "llama3.2:latest" are the same model to Ollama. */
export function withTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/** The Ollama root URL for a provider base URL (`http://host:11434/v1` → `http://host:11434`). */
export function ollamaRoot(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
}

/**
 * Local models through Ollama: find the server, pull a model with progress, and set it up as
 * the instance's Ollama provider (Ollama speaks the OpenAI API under /v1, which is how crew
 * use it). Pulls run in the background; the page polls for progress.
 */
export class LocalAiService {
  #pulls = new Map<string, Pull>();
  #aborts = new Set<AbortController>();

  constructor(
    private readonly providers: ProviderService,
    private readonly settings: SettingsService,
    private readonly defaultUrl: string = DEFAULT_OLLAMA_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The URL to use: the one asked for, else the Ollama provider's server, else the default. */
  async url(requested?: string): Promise<string> {
    if (requested?.trim()) return ollamaRoot(requested);
    const existing = await this.#provider();
    return ollamaRoot(existing?.baseUrl ?? this.defaultUrl);
  }

  async status(requested?: string): Promise<LocalAiStatusDto> {
    const url = await this.url(requested);
    const [provider, settings] = await Promise.all([this.#provider(), this.settings.get()]);
    const base = {
      url,
      recommended: RECOMMENDED_MODELS,
      providerId: provider?.id ?? null,
      defaultModel: settings.defaultModel,
      pulls: this.#listPulls(),
    };
    try {
      const version = await this.#json<{ version?: string }>(url, "/api/version");
      const tags = await this.#json<{ models?: Array<{ name?: string; size?: number }> }>(
        url,
        "/api/tags",
      );
      const installed: LocalModelDto[] = (tags.models ?? [])
        .filter((m): m is { name: string; size?: number } => typeof m.name === "string")
        .map((m) => ({ name: m.name, sizeBytes: typeof m.size === "number" ? m.size : null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        ...base,
        reachable: true,
        version: version.version ?? null,
        error: null,
        installed,
      };
    } catch (err) {
      return {
        ...base,
        reachable: false,
        version: null,
        error: describe(err, url),
        installed: [],
      };
    }
  }

  /** Start pulling a model; a pull of the same model already running is returned as is. */
  async pull(model: string, requested?: string): Promise<LocalModelPullDto> {
    const name = checkName(model);
    const url = await this.url(requested);
    const running = this.#pulls.get(withTag(name));
    if (running?.status === "pulling") return toDto(running);
    const pull: Pull = {
      model: withTag(name),
      status: "pulling",
      detail: "starting",
      completedBytes: 0,
      totalBytes: 0,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      layers: new Map(),
    };
    this.#pulls.set(pull.model, pull);
    void this.#run(url, name, pull);
    return toDto(pull);
  }

  /**
   * Make the model usable by crew: add the Ollama provider (or update the one there) so it lists
   * the model, and optionally make it the instance default model.
   */
  async use(
    model: string,
    options: { url?: string | undefined; makeDefault?: boolean | undefined } = {},
  ): Promise<ProviderDto> {
    const name = checkName(model);
    const url = await this.url(options.url);
    const status = await this.status(url);
    if (!status.reachable) throw new HttpError(502, status.error ?? `cannot reach ${url}`);
    const installed = status.installed.map((m) => m.name);
    if (!installed.includes(withTag(name)) && !installed.includes(name)) {
      throw new HttpError(409, `${name} is not on the Ollama server yet; pull it first`);
    }
    // The exact name Ollama lists, so `ollama/<name>` refs match what /v1 serves.
    const listed = installed.includes(name) ? name : withTag(name);
    const baseUrl = `${url}/v1`;
    const existing = await this.#provider();
    const provider = existing
      ? await this.providers.update(existing.id, {
          baseUrl,
          enabled: true,
          models: [...new Set([...existing.models, listed])],
        })
      : await this.providers.create({ kind: "ollama", label: "Ollama", baseUrl, models: [listed] });
    if (options.makeDefault) await this.settings.set({ defaultModel: `ollama/${listed}` });
    return provider;
  }

  /** Stop pulls in flight (app shutdown). */
  close() {
    for (const c of this.#aborts) c.abort();
  }

  async #provider(): Promise<ProviderDto | undefined> {
    return (await this.providers.list()).find((p) => p.kind === "ollama");
  }

  #listPulls(): LocalModelPullDto[] {
    const now = Date.now();
    for (const [key, p] of this.#pulls) {
      if (p.finishedAt !== null && now - p.finishedAt > KEEP_FINISHED_MS) this.#pulls.delete(key);
    }
    return [...this.#pulls.values()].map(toDto);
  }

  async #json<T>(url: string, path: string): Promise<T> {
    const res = await this.fetchImpl(`${url}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}${path}`);
    return (await res.json()) as T;
  }

  /** POST /api/pull streams JSON lines; each layer reports its own total and progress. */
  async #run(url: string, name: string, pull: Pull) {
    const controller = new AbortController();
    this.#aborts.add(controller);
    try {
      const res = await this.fetchImpl(`${url}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `name` for older Ollama versions, `model` for current ones.
        body: JSON.stringify({ model: name, name, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new OllamaError(errorText(text) || `${res.status} ${res.statusText}`);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let succeeded = false;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line && applyLine(pull, line)) succeeded = true;
          nl = buffer.indexOf("\n");
        }
      }
      if (buffer.trim() && applyLine(pull, buffer.trim())) succeeded = true;
      if (pull.error) throw new OllamaError(pull.error);
      if (!succeeded) throw new OllamaError("Ollama ended the download without finishing it");
      pull.status = "done";
      pull.detail = "success";
      if (pull.totalBytes > 0) pull.completedBytes = pull.totalBytes;
    } catch (err) {
      pull.status = "failed";
      pull.error = controller.signal.aborted
        ? "stopped"
        : err instanceof OllamaError
          ? err.message
          : describe(err, url);
    } finally {
      pull.finishedAt = Date.now();
      this.#aborts.delete(controller);
    }
  }
}

/** Fold one progress line into the pull; true when it says the pull succeeded. */
export function applyLine(
  pull: Pick<Pull, "detail" | "completedBytes" | "totalBytes" | "error" | "layers">,
  line: string,
): boolean {
  let msg: { status?: string; digest?: string; total?: number; completed?: number; error?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return false;
  }
  if (msg.error) {
    pull.error = msg.error;
    return false;
  }
  if (msg.status) pull.detail = msg.status;
  if (msg.digest && typeof msg.total === "number") {
    pull.layers.set(msg.digest, { total: msg.total, completed: msg.completed ?? 0 });
    let total = 0;
    let completed = 0;
    for (const l of pull.layers.values()) {
      total += l.total;
      completed += Math.min(l.completed, l.total);
    }
    pull.totalBytes = total;
    pull.completedBytes = completed;
  }
  return msg.status === "success";
}

/** A failure Ollama itself reported (as opposed to not reaching it). */
class OllamaError extends Error {}

function toDto(p: Pull): LocalModelPullDto {
  return {
    model: p.model,
    status: p.status,
    detail: p.detail,
    completedBytes: p.completedBytes,
    totalBytes: p.totalBytes,
    error: p.error,
    startedAt: p.startedAt,
  };
}

function checkName(model: string): string {
  const name = model.trim();
  if (!MODEL_NAME_RE.test(name) || name.length > 200) {
    throw new HttpError(400, `"${model}" is not an Ollama model name (like qwen3:4b)`);
  }
  return name;
}

function errorText(body: string): string {
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body.trim();
  } catch {
    return body.trim();
  }
}

/** A connection failure in plain words, with the most likely fix. */
function describe(err: unknown, url: string): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const code = e.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `No Ollama server at ${url}: that name does not resolve. Start the bundled one, or enter the address of yours.`;
  }
  if (code === "ECONNREFUSED") {
    return `Nothing is listening at ${url}. Is Ollama running?`;
  }
  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return `${url} did not answer in time.`;
  }
  // fetch says only "fetch failed"; the reason is in its cause.
  const reason = e.cause?.message ? `${e.message}: ${e.cause.message}` : e.message;
  return `Could not reach ${url} (${reason || String(err)}).`;
}
