import type { Db } from "@shipmate/db";
import { settings } from "@shipmate/db";
import { eq } from "drizzle-orm";

export interface InstanceSettings {
  captainName: string;
  defaultModel: string;
  /** Model for photos when a crew member's cannot see images; "" = pick automatically. */
  visionModel: string;
}

export const DEFAULT_SETTINGS: InstanceSettings = {
  captainName: "Captain",
  defaultModel: "anthropic/claude-sonnet-5-5",
  visionModel: "",
};

/** Instance settings stored one key per row; unknown keys fall back to defaults. */
export class SettingsService {
  constructor(private readonly db: Db) {}

  async get(): Promise<InstanceSettings> {
    const rows = await this.db.select().from(settings);
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key in out && typeof row.value === "string") {
        out[row.key as keyof InstanceSettings] = row.value;
      }
    }
    return out;
  }

  async set(
    patch: { [K in keyof InstanceSettings]?: InstanceSettings[K] | undefined },
  ): Promise<InstanceSettings> {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      await this.db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    }
    return this.get();
  }

  /** A feature's settings stored as one JSON value under `key` (e.g. "oidc"), or null. */
  async getJson<T>(key: string): Promise<T | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return row ? (row.value as T) : null;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}
