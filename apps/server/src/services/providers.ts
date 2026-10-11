import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelOption, ProviderDto, ProviderKindDto } from "@shipmate/core";
import { type Db, providers, secrets } from "@shipmate/db";
import {
  defaultBaseUrl,
  PROVIDER_KINDS,
  ProviderBinder,
  type ProviderRecord,
  piProviderId,
  probeModels,
  providerKind,
  SELF_HOSTED_KINDS,
  type SecretVault,
} from "@shipmate/providers";
import { eq, inArray } from "drizzle-orm";
import { HttpError } from "../auth.js";
import { ChatGptService } from "./chatgpt.js";

type ProviderRow = typeof providers.$inferSelect;

const secretRef = (providerId: string) => `provider:${providerId}`;

/**
 * Provider credentials are instance-wide and set by the owner (Q4). Keys live encrypted in the
 * secrets table and are handed to pi as runtime keys, so they never touch pi's auth.json.
 */
export class ProviderService {
  readonly #binder: ProviderBinder;
  #configured = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
    readonly runtime: ModelRuntime,
    /** pi provider ids usable without a row here (tests register a scripted provider). */
    private readonly extraProviders: string[] = [],
  ) {
    this.#binder = new ProviderBinder(runtime);
    this.chatgpt = new ChatGptService(db, vault, runtime);
  }

  /** Sign in with ChatGPT (phase 5): its tokens live in the vault, not in a providers row. */
  readonly chatgpt: ChatGptService;

  kinds(): ProviderKindDto[] {
    return PROVIDER_KINDS.map((k) => ({
      kind: k.kind,
      label: k.label,
      auth: k.auth,
      ...("comingSoon" in k ? { comingSoon: true } : {}),
    }));
  }

  async list(): Promise<ProviderDto[]> {
    const rows = await this.db.select().from(providers).orderBy(providers.createdAt);
    return rows.map(toDto);
  }

  async create(input: {
    kind: string;
    label?: string | undefined;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    models?: string[] | undefined;
  }): Promise<ProviderDto> {
    const kind = providerKind(input.kind);
    if (!kind) throw new HttpError(400, `unknown provider kind "${input.kind}"`);
    if ("comingSoon" in kind) throw new HttpError(400, `${kind.label} arrives in a later release`);
    if (kind.kind === "openai-chatgpt")
      throw new HttpError(400, "use Sign in with ChatGPT on the Providers page instead");
    if (kind.kind === "claude-code-cli")
      throw new HttpError(
        400,
        "sign in to Claude Code in the container and pick the backend per crew member",
      );
    if (kind.auth === "api-key" && !input.apiKey)
      throw new HttpError(400, "an API key is required");
    const label = input.label?.trim() || defaultLabel(kind.kind);
    const pid = piProviderId({ kind: kind.kind, label });
    const existing = (await this.db.select().from(providers)).find((p) => piProviderId(p) === pid);
    if (existing) throw new HttpError(409, `a provider named "${pid}" is already configured`);
    const selfHosted = SELF_HOSTED_KINDS.includes(kind.kind);
    const [row] = await this.db
      .insert(providers)
      .values({
        kind: kind.kind,
        label,
        baseUrl: selfHosted ? input.baseUrl?.trim() || defaultBaseUrl(kind.kind) : null,
        models: selfHosted ? cleanModels(input.models) : [],
      })
      .returning();
    if (!row) throw new Error("insert failed");
    if (input.apiKey) await this.#setKey(row.id, input.apiKey);
    await this.sync();
    return this.#dto(row.id);
  }

  async update(
    id: string,
    patch: {
      label?: string | undefined;
      baseUrl?: string | null | undefined;
      apiKey?: string | undefined;
      enabled?: boolean | undefined;
      models?: string[] | undefined;
    },
  ): Promise<ProviderDto> {
    const row = await this.#row(id);
    const values: Partial<ProviderRow> = {};
    if (patch.label?.trim()) values.label = patch.label.trim();
    if (patch.baseUrl !== undefined && SELF_HOSTED_KINDS.includes(row.kind)) {
      values.baseUrl = patch.baseUrl?.trim() || defaultBaseUrl(row.kind);
    }
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.models !== undefined) values.models = cleanModels(patch.models);
    if (Object.keys(values).length) {
      await this.db.update(providers).set(values).where(eq(providers.id, id));
    }
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === "") await this.#clearKey(id);
      else await this.#setKey(id, patch.apiKey);
    }
    await this.sync();
    return this.#dto(id);
  }

  async remove(id: string): Promise<void> {
    await this.#row(id);
    await this.#clearKey(id);
    await this.db.delete(providers).where(eq(providers.id, id));
    await this.sync();
  }

  async probe(id: string): Promise<string[]> {
    const row = await this.#row(id);
    if (!SELF_HOSTED_KINDS.includes(row.kind)) {
      throw new HttpError(400, "only self-hosted providers can be probed");
    }
    let models: string[];
    try {
      models = await probeModels(row.baseUrl ?? defaultBaseUrl(row.kind), await this.#key(row));
    } catch (err) {
      throw new HttpError(502, `could not list models: ${(err as Error).message}`);
    }
    await this.db.update(providers).set({ models }).where(eq(providers.id, id));
    await this.sync();
    return models;
  }

  /** Every provider with its key decrypted (server-side only: sync and health checks). */
  async records(): Promise<ProviderRecord[]> {
    const rows = await this.db.select().from(providers).orderBy(providers.createdAt);
    const records: ProviderRecord[] = [];
    for (const r of rows) {
      records.push({
        id: r.id,
        kind: r.kind,
        label: r.label,
        baseUrl: r.baseUrl,
        apiKey: await this.#key(r),
        models: r.models,
        enabled: r.enabled,
      });
    }
    return records;
  }

  /** Push the table into pi's ModelRuntime. Called at boot and after every change. */
  async sync(): Promise<void> {
    const records = await this.records();
    await this.#binder.sync(records);
    await this.chatgpt.boot();
    this.#configured = new Set([
      ...this.extraProviders,
      ...records
        .filter((r) => r.enabled && (r.apiKey || SELF_HOSTED_KINDS.includes(r.kind)))
        .map((r) => piProviderId(r))
        .filter((id): id is string => Boolean(id)),
    ]);
  }

  /** Every chat model pi knows, with the ones that have credentials first. */
  async models(): Promise<ModelOption[]> {
    const available = new Set((await this.available()).map((m) => `${m.provider}/${m.id}`));
    const all = this.runtime.getModels().map((m) => ({
      ref: `${m.provider}/${m.id}`,
      provider: m.provider,
      id: m.id,
      name: m.name,
      available: available.has(`${m.provider}/${m.id}`),
      images: m.input.includes("image"),
    }));
    return all.sort((a, b) => Number(b.available) - Number(a.available));
  }

  /**
   * Models crew can actually use: ones pi has credentials for, from providers configured here.
   * pi would also pick up ambient credentials (env vars, cloud metadata), which an owner did not
   * choose to spend, so those do not count.
   */
  async available(): Promise<Model<Api>[]> {
    return (await this.runtime.getAvailable()).filter(
      (m) => this.#configured.has(m.provider) || this.chatgpt.configures(m.provider),
    );
  }

  async #dto(id: string): Promise<ProviderDto> {
    return toDto(await this.#row(id));
  }

  async #row(id: string): Promise<ProviderRow> {
    const [row] = await this.db.select().from(providers).where(eq(providers.id, id)).limit(1);
    if (!row) throw new HttpError(404, "provider not found");
    return row;
  }

  async #key(row: ProviderRow): Promise<string | null> {
    if (!row.secretRef) return null;
    const [s] = await this.db.select().from(secrets).where(eq(secrets.ref, row.secretRef)).limit(1);
    return s ? this.vault.decrypt(s.ciphertext) : null;
  }

  async #setKey(id: string, key: string) {
    const ref = secretRef(id);
    const ciphertext = this.vault.encrypt(key.trim());
    await this.db
      .insert(secrets)
      .values({ ref, ciphertext })
      .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
    await this.db.update(providers).set({ secretRef: ref }).where(eq(providers.id, id));
  }

  async #clearKey(id: string) {
    await this.db.delete(secrets).where(inArray(secrets.ref, [secretRef(id)]));
    await this.db.update(providers).set({ secretRef: null }).where(eq(providers.id, id));
  }
}

function toDto(r: ProviderRow): ProviderDto {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    baseUrl: r.baseUrl,
    hasSecret: Boolean(r.secretRef),
    enabled: r.enabled,
    models: r.models,
    createdAt: r.createdAt.toISOString(),
  };
}

function defaultLabel(kind: string): string {
  if (kind === "ollama") return "Ollama";
  if (kind === "openai-compatible") return "Local";
  return providerKind(kind)?.label.replace(/ \(.*\)$/, "") ?? kind;
}

function cleanModels(models: string[] | undefined): string[] {
  return [...new Set((models ?? []).map((m) => m.trim()).filter(Boolean))];
}
