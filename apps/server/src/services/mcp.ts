import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { CrewFolder } from "@shipmate/crew";
import { type Db, secrets } from "@shipmate/db";
import { type CatalogEntry, loadCatalog } from "@shipmate/mcp-catalog";
import type { SecretVault } from "@shipmate/providers";
import { like } from "drizzle-orm";

/** Vault ref for one MCP server secret, e.g. `mcp:github:GITHUB_PERSONAL_ACCESS_TOKEN`. */
export const mcpSecretRef = (serverId: string, env: string) => `mcp:${serverId}:${env}`;

/**
 * Resolves a crew member's `mcp:` list into pi MCP server configs. Core servers need no install
 * step (Q7); servers whose required secrets are missing are skipped and reported, not started.
 */
export class McpService {
  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
    private readonly enabled: boolean,
  ) {}

  get isEnabled() {
    return this.enabled;
  }

  async serversFor(
    crew: CrewFolder,
  ): Promise<{ servers: Record<string, McpServerConfig>; skipped: string[] }> {
    const servers: Record<string, McpServerConfig> = {};
    const skipped: string[] = [];
    if (!this.enabled || !crew.manifest.mcp.length) return { servers, skipped };
    const catalog = new Map(loadCatalog().map((e) => [e.id, e]));
    const stored = await this.#secrets();
    for (const id of crew.manifest.mcp) {
      const entry = catalog.get(id);
      if (!entry) {
        skipped.push(`${id} (not in the catalog)`);
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
      servers[id] = toConfig(entry, env, crew.dir);
    }
    return { servers, skipped };
  }

  async #secrets(): Promise<Map<string, string>> {
    const rows = await this.db.select().from(secrets).where(like(secrets.ref, "mcp:%"));
    return new Map(rows.map((r) => [r.ref, this.vault.decrypt(r.ciphertext)]));
  }
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
  const args = entry.id === "filesystem" ? [...entry.args, crewDir] : entry.args;
  return {
    command: entry.command ?? "npx",
    args,
    env,
    exposure: "direct",
    description,
  };
}
