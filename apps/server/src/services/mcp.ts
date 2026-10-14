import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { CreateCustomMcpRequest, McpGoogleDto, McpServerDto } from "@shipmate/core";
import type { CrewFolder } from "@shipmate/crew";
import { type Db, mcpServers, secrets } from "@shipmate/db";
import { CatalogEntry, loadCatalog } from "@shipmate/mcp-catalog";
import type { SecretVault } from "@shipmate/providers";
import { eq, like } from "drizzle-orm";
import { HttpError } from "../auth.js";
import type { CrewService } from "./crew.js";
import type { GoogleClient, GoogleOAuthService } from "./google-oauth.js";

/** Vault ref for one MCP server secret, e.g. `mcp:github:GITHUB_PERSONAL_ACCESS_TOKEN`. */
export const mcpSecretRef = (serverId: string, env: string) => `mcp:${serverId}:${env}`;

type Entry = CatalogEntry & { custom: boolean };

/**
 * The MCP catalog and installer (§9). Core servers are always installed (Q7); catalog servers
 * are installed with one click; owners can add custom ones. A crew member's `mcp:` list says
 * which it gets, and servers whose required secrets are missing are skipped, not started.
 */
export class McpService {
  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
    private readonly crew: CrewService,
    private readonly enabled: boolean,
    private readonly google?: GoogleOAuthService,
  ) {}

  get isEnabled() {
    return this.enabled;
  }

  async list(): Promise<McpServerDto[]> {
    const { entries, installed } = await this.#entries();
    const stored = await this.#secretRefs();
    const folders = this.crew.registry.list();
    const google = entries.some((e) => e.oauth === "google") ? await this.#googleDto() : null;
    return entries
      .map((e) => this.#dto(e, installed, stored, folders, google))
      .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<McpServerDto> {
    const server = (await this.list()).find((s) => s.id === id);
    if (!server) throw new HttpError(404, `no MCP server "${id}"`);
    return server;
  }

  async install(id: string): Promise<McpServerDto> {
    const entry = loadCatalog().find((e) => e.id === id);
    if (!entry) throw new HttpError(404, `"${id}" is not in the MCP catalog`);
    if (entry.tier === "catalog") {
      await this.db.insert(mcpServers).values({ id }).onConflictDoNothing();
    }
    return this.get(id);
  }

  async uninstall(id: string): Promise<void> {
    const entry = loadCatalog().find((e) => e.id === id);
    if (entry?.tier === "core") throw new HttpError(400, "core servers are always installed");
    const [row] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!row) throw new HttpError(404, `"${id}" is not installed`);
    await this.assign(id, []);
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id));
    await this.db.delete(secrets).where(like(secrets.ref, `${mcpSecretRef(id, "")}%`));
    if (entry?.oauth === "google") await this.google?.signOut();
  }

  /** The Google OAuth client the owner saved on the Google server, or null. */
  async googleClient(): Promise<GoogleClient | null> {
    const entry = loadCatalog().find((e) => e.oauth === "google");
    if (!entry) return null;
    const stored = await this.#secrets();
    const clientId = stored.get(mcpSecretRef(entry.id, "GOOGLE_OAUTH_CLIENT_ID"));
    const clientSecret = stored.get(mcpSecretRef(entry.id, "GOOGLE_OAUTH_CLIENT_SECRET"));
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  async #googleDto(): Promise<McpGoogleDto | null> {
    if (!this.google) return null;
    const { uri, pasteBack } = this.google.redirect;
    return {
      redirectUri: uri,
      pasteBack,
      ...(await this.google.status(await this.googleClient())),
    };
  }

  async addCustom(input: CreateCustomMcpRequest): Promise<McpServerDto> {
    if (loadCatalog().some((e) => e.id === input.id)) {
      throw new HttpError(409, `"${input.id}" is already a catalog server`);
    }
    const spec = CatalogEntry.parse({
      id: input.id,
      name: input.name,
      description: input.description ?? "",
      tier: "catalog",
      transport: input.transport,
      command: input.command,
      args: input.args ?? [],
      url: input.url,
      secrets: (input.secrets ?? []).map((s) => ({
        env: s.env,
        label: s.label ?? s.env,
        required: s.required ?? true,
      })),
    });
    if (spec.transport === "stdio" && !spec.command) {
      throw new HttpError(400, "a stdio server needs a command");
    }
    if (spec.transport === "http" && !spec.url)
      throw new HttpError(400, "an http server needs a url");
    await this.db
      .insert(mcpServers)
      .values({ id: spec.id, spec, custom: true })
      .onConflictDoUpdate({ target: mcpServers.id, set: { spec, custom: true } });
    return this.get(spec.id);
  }

  /** Set (or with "" clear) secret values; only env names the server declares are accepted. */
  async setSecrets(id: string, values: Record<string, string>): Promise<McpServerDto> {
    const { entries } = await this.#entries();
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new HttpError(404, `no MCP server "${id}"`);
    const known = new Set(entry.secrets.map((s) => s.env));
    for (const [env, value] of Object.entries(values)) {
      if (!known.has(env)) throw new HttpError(400, `${id} does not use ${env}`);
      const ref = mcpSecretRef(id, env);
      if (!value) {
        await this.db.delete(secrets).where(eq(secrets.ref, ref));
        continue;
      }
      const ciphertext = this.vault.encrypt(value);
      await this.db
        .insert(secrets)
        .values({ ref, ciphertext })
        .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
    }
    return this.get(id);
  }

  /** Make `crews` exactly the crew members whose crew.yaml lists this server. */
  async assign(id: string, crews: string[]): Promise<McpServerDto> {
    const wanted = new Set(crews);
    for (const slug of wanted) this.crew.folder(slug);
    for (const folder of this.crew.registry.list()) {
      const has = folder.manifest.mcp.includes(id);
      if (has === wanted.has(folder.slug)) continue;
      const mcp = has ? folder.manifest.mcp.filter((m) => m !== id) : [...folder.manifest.mcp, id];
      await this.crew.patch(folder.slug, { mcp });
    }
    return this.get(id);
  }

  async serversFor(
    crew: CrewFolder,
  ): Promise<{ servers: Record<string, McpServerConfig>; skipped: string[] }> {
    const servers: Record<string, McpServerConfig> = {};
    const skipped: string[] = [];
    if (!this.enabled || !crew.manifest.mcp.length) return { servers, skipped };
    const { entries, installed } = await this.#entries();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const stored = await this.#secrets();
    for (const id of crew.manifest.mcp) {
      const entry = byId.get(id);
      if (!entry) {
        skipped.push(`${id} (not in the catalog)`);
        continue;
      }
      if (entry.tier !== "core" && !installed.has(id)) {
        skipped.push(`${id} (not installed)`);
        continue;
      }
      const env: Record<string, string> = {};
      let missing = false;
      for (const s of entry.secrets) {
        const value = stored.get(mcpSecretRef(id, s.env));
        if (value) env[s.env] = value;
        else if (s.required) missing = true;
      }
      if (missing) {
        skipped.push(`${id} (needs ${entry.secrets.map((s) => s.label).join(", ")})`);
        continue;
      }
      if (entry.needsOneSecret && !Object.keys(env).length) {
        skipped.push(`${id} (needs ${entry.secrets.map((s) => s.label).join(" or ")})`);
        continue;
      }
      if (entry.oauth === "google") {
        const signedIn = await this.google?.serverEnv(await this.googleClient());
        if (!signedIn) {
          skipped.push(`${id} (needs Sign in with Google)`);
          continue;
        }
        Object.assign(env, signedIn);
      }
      servers[id] = toConfig(entry, env, crew.dir);
    }
    return { servers, skipped };
  }

  async #entries(): Promise<{ entries: Entry[]; installed: Set<string> }> {
    const rows = await this.db.select().from(mcpServers);
    const entries: Entry[] = loadCatalog().map((e) => ({ ...e, custom: false }));
    for (const r of rows) {
      if (!r.custom) continue;
      const parsed = CatalogEntry.safeParse(r.spec);
      if (parsed.success) entries.push({ ...parsed.data, custom: true });
    }
    return { entries, installed: new Set(rows.map((r) => r.id)) };
  }

  #dto(
    e: Entry,
    installed: Set<string>,
    stored: Set<string>,
    folders: CrewFolder[],
    google: McpGoogleDto | null,
  ): McpServerDto {
    const isInstalled = e.tier === "core" || installed.has(e.id);
    const secretDtos = e.secrets.map((s) => ({
      env: s.env,
      label: s.label,
      required: s.required,
      set: stored.has(mcpSecretRef(e.id, s.env)),
    }));
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      tier: e.custom ? "custom" : e.tier,
      transport: e.transport,
      command: e.command ?? null,
      args: e.args,
      url: e.url ?? null,
      installed: isInstalled,
      secrets: secretDtos,
      needsOneSecret: e.needsOneSecret,
      ready:
        isInstalled &&
        secretDtos.every((s) => s.set || !s.required) &&
        (!e.needsOneSecret || secretDtos.some((s) => s.set)) &&
        (e.oauth !== "google" || Boolean(google?.signedIn && !google.stale)),
      crews: folders.filter((f) => f.manifest.mcp.includes(e.id)).map((f) => f.slug),
      tags: e.tags,
      homepage: e.homepage ?? null,
      google: e.oauth === "google" ? google : null,
    };
  }

  async #secretRefs(): Promise<Set<string>> {
    const rows = await this.db
      .select({ ref: secrets.ref })
      .from(secrets)
      .where(like(secrets.ref, "mcp:%"));
    return new Set(rows.map((r) => r.ref));
  }

  async #secrets(): Promise<Map<string, string>> {
    const rows = await this.db.select().from(secrets).where(like(secrets.ref, "mcp:%"));
    return new Map(rows.map((r) => [r.ref, this.vault.decrypt(r.ciphertext)]));
  }
}

const tierOrder = { core: 0, catalog: 1, custom: 2 } as const;

/**
 * The browser server's extra arguments: the Chromium the image ships (docker/Dockerfile sets
 * SHIPMATE_BROWSER_PATH; elsewhere Playwright uses its own download), and a fresh in-memory
 * profile each time. Every conversation starts its own browser server, and Chromium locks an
 * on-disk profile, so a shared one would stop the second conversation's browser from starting.
 */
export function browserArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const browser = env.SHIPMATE_BROWSER_PATH?.trim();
  return ["--isolated", ...(browser ? ["--executable-path", browser] : [])];
}

export function toConfig(
  entry: CatalogEntry,
  env: Record<string, string>,
  crewDir: string,
): McpServerConfig {
  const description = entry.description;
  if (entry.transport === "http") {
    const token = Object.values(env)[0];
    return {
      url: entry.url ?? "",
      exposure: "direct",
      description,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    };
  }
  // The filesystem server only sees the crew member's own folder.
  const args = entry.id === "filesystem" ? [...entry.args, crewDir] : [...entry.args];
  if (entry.id === "browser") args.push(...browserArgs());
  return {
    command: entry.command ?? "npx",
    args,
    env,
    exposure: "direct",
    description,
  };
}
