import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BackupDto, BackupSettingsDto } from "@shipmate/core";
import { SHIPMATE_VERSION } from "@shipmate/core";
import { BACKUP_NAME_RE, backupFileName, backupTrigger, createBackup, type Db } from "@shipmate/db";
import { Cron } from "croner";
import { HttpError } from "../auth.js";
import type { AuditService } from "./audit.js";
import type { SettingsService } from "./settings.js";

const SETTINGS_KEY = "backups";
export const DEFAULT_BACKUP_SETTINGS = { hourUtc: 3 as number | null, keep: 7 };

/**
 * Backups of the database and the data folder, written to the backups folder (inside the data
 * volume by default). A nightly job runs at `hourUtc`; only scheduled backups are pruned to the
 * newest `keep`, so manual and CLI backups stay until someone deletes them.
 */
export class BackupService {
  #job: Cron | null = null;
  #running: Promise<BackupDto> | null = null;
  #started = false;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly dataDir: string,
    readonly dir: string,
  ) {}

  async getSettings(): Promise<BackupSettingsDto> {
    const stored = await this.settings.getJson<Partial<BackupSettingsDto>>(SETTINGS_KEY);
    return {
      hourUtc: stored?.hourUtc === undefined ? DEFAULT_BACKUP_SETTINGS.hourUtc : stored.hourUtc,
      keep: stored?.keep ?? DEFAULT_BACKUP_SETTINGS.keep,
      dir: this.dir,
    };
  }

  async updateSettings(patch: {
    hourUtc?: number | null | undefined;
    keep?: number | undefined;
  }): Promise<BackupSettingsDto> {
    const current = await this.getSettings();
    const next = {
      hourUtc: patch.hourUtc === undefined ? current.hourUtc : patch.hourUtc,
      keep: patch.keep ?? current.keep,
    };
    await this.settings.setJson(SETTINGS_KEY, next);
    if (this.#started) this.#schedule(next.hourUtc);
    return { ...next, dir: this.dir };
  }

  async list(): Promise<BackupDto[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: BackupDto[] = [];
    for (const name of names) {
      if (!BACKUP_NAME_RE.test(name)) continue;
      const st = await stat(join(this.dir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({
        name,
        sizeBytes: st.size,
        createdAt: st.mtime.toISOString(),
        trigger: backupTrigger(name),
      });
    }
    return out.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name),
    );
  }

  /** Back up now. One backup runs at a time; a second request waits for and shares it. */
  run(trigger: "manual" | "scheduled", userId: string | null = null): Promise<BackupDto> {
    if (this.#running) return this.#running;
    this.#running = this.#run(trigger, userId).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #run(trigger: "manual" | "scheduled", userId: string | null): Promise<BackupDto> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const now = new Date();
    let name = backupFileName(trigger, now);
    for (let n = 2; existsSync(join(this.dir, name)); n++) name = backupFileName(trigger, now, n);
    const result = await createBackup({
      db: this.db,
      dataDir: this.dataDir,
      outFile: join(this.dir, name),
      trigger,
      version: SHIPMATE_VERSION,
      exclude: [this.dir],
    });
    await this.audit.record({
      userId,
      crewMemberId: null,
      action: "backup.create",
      summary: `Backup ${name} (${trigger})`,
      decision: null,
      detail: { name, sizeBytes: result.sizeBytes },
    });
    if (trigger === "scheduled") await this.prune();
    return {
      name,
      sizeBytes: result.sizeBytes,
      createdAt: result.manifest.createdAt,
      trigger,
    };
  }

  /** Delete scheduled backups beyond the newest `keep`. */
  async prune(): Promise<string[]> {
    const { keep } = await this.getSettings();
    const old = (await this.list()).filter((b) => b.trigger === "scheduled").slice(keep);
    for (const b of old) await rm(join(this.dir, b.name), { force: true });
    return old.map((b) => b.name);
  }

  /** The absolute path of an existing backup, after strict name checks. */
  async file(name: string): Promise<{ path: string; size: number }> {
    if (!BACKUP_NAME_RE.test(name)) throw new HttpError(400, "invalid backup name");
    const path = join(this.dir, name);
    if (resolve(path) !== resolve(this.dir, name)) throw new HttpError(400, "invalid backup name");
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, "no such backup");
    return { path, size: st.size };
  }

  async stream(name: string) {
    const { path, size } = await this.file(name);
    return { stream: createReadStream(path), size };
  }

  async remove(name: string, userId: string | null = null): Promise<void> {
    const { path } = await this.file(name);
    await rm(path, { force: true });
    await this.audit.record({
      userId,
      crewMemberId: null,
      action: "backup.delete",
      summary: `Deleted backup ${name}`,
      decision: null,
    });
  }

  // ---------- schedule ----------

  async start(): Promise<void> {
    this.#started = true;
    this.#schedule((await this.getSettings()).hourUtc);
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#job?.stop();
    this.#job = null;
    await this.#running?.catch(() => {});
  }

  /** When the nightly job runs next; null when off. */
  nextRun(): Date | null {
    return this.#job?.nextRun() ?? null;
  }

  #schedule(hourUtc: number | null) {
    this.#job?.stop();
    this.#job = null;
    if (hourUtc === null) return;
    this.#job = new Cron(`0 ${hourUtc} * * *`, { timezone: "UTC", protect: true }, () => {
      void this.run("scheduled").catch(() => {});
    });
  }
}
