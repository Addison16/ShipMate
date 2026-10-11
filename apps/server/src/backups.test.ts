import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupDto } from "@shipmate/core";
import { backupTables, readBackupManifest, restoreBackup } from "@shipmate/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/** Every table as sorted to_jsonb text, so a comparison is exact (types, digits, offsets). */
async function snapshot(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const out: Record<string, string[]> = {};
    for (const t of backupTables()) {
      const rows = await sql.unsafe<Array<{ j: string }>>(
        `select to_jsonb(t)::text as j from "${t}" t order by 1`,
      );
      out[t] = rows.map((r) => r.j);
    }
    return out;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!db)("Shipmate phase 4: backups", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
  let dataDir = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
    cookie = ownerCookie,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  beforeAll(async () => {
    t = await testApp(db as string);
    dataDir = t.config.dirs.root;
    ownerCookie = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("is owner-only and lists settings with defaults", async () => {
    expect((await api("GET", "/api/backups", undefined, memberCookie)).statusCode).toBe(403);
    expect((await api("POST", "/api/backups", undefined, memberCookie)).statusCode).toBe(403);
    const res = await api("GET", "/api/backups");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      backups: [],
      settings: { hourUtc: 3, keep: 7, dir: join(dataDir, "backups") },
    });
    expect(t.app.services.backups.nextRun()?.getUTCHours()).toBe(3);
  });

  it("updates the schedule and validates it", async () => {
    const res = await api("PUT", "/api/backups/settings", { hourUtc: 5, keep: 2 });
    expect(res.json().settings).toMatchObject({ hourUtc: 5, keep: 2 });
    expect(t.app.services.backups.nextRun()?.getUTCHours()).toBe(5);
    expect((await api("PUT", "/api/backups/settings", { hourUtc: 24 })).statusCode).toBe(400);
    expect((await api("PUT", "/api/backups/settings", { keep: 0 })).statusCode).toBe(400);
    await api("PUT", "/api/backups/settings", { hourUtc: null });
    expect(t.app.services.backups.nextRun()).toBeNull();
    expect((await api("GET", "/api/backups")).json().settings.hourUtc).toBeNull();
  });

  it("backs up now, downloads, deletes, and rejects unsafe names", async () => {
    const res = await api("POST", "/api/backups");
    expect(res.statusCode).toBe(200);
    const backup = res.json().backup as BackupDto;
    expect(backup.name).toMatch(/^shipmate-\d{4}-\d{2}-\d{2}T\d{6}Z-manual\.tar\.gz$/);
    expect(backup.trigger).toBe("manual");
    const list = (await api("GET", "/api/backups")).json().backups as BackupDto[];
    expect(list.map((b) => b.name)).toEqual([backup.name]);

    const dl = await api("GET", `/api/backups/${backup.name}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/gzip");
    expect(dl.rawPayload.length).toBe(backup.sizeBytes);
    expect(dl.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(
      (await api("GET", `/api/backups/${backup.name}`, undefined, memberCookie)).statusCode,
    ).toBe(403);

    for (const bad of [
      "..%2F..%2Fetc%2Fpasswd",
      "..%2Fx.tar.gz",
      ".secret",
      "x.txt",
      "%2Fetc.tar.gz",
    ]) {
      const r = await api("GET", `/api/backups/${bad}`);
      expect([400, 404]).toContain(r.statusCode);
      expect((await api("DELETE", `/api/backups/${bad}`)).statusCode).not.toBe(200);
    }
    expect((await api("GET", "/api/backups/nope.tar.gz")).statusCode).toBe(404);

    expect((await api("DELETE", `/api/backups/${backup.name}`)).json()).toEqual({ ok: true });
    expect((await api("GET", "/api/backups")).json().backups).toEqual([]);
  });

  it("prunes only scheduled backups to `keep`", async () => {
    await api("PUT", "/api/backups/settings", { keep: 2 });
    const manual = await t.app.services.backups.run("manual");
    const made: BackupDto[] = [];
    for (let i = 0; i < 3; i++) made.push(await t.app.services.backups.run("scheduled"));
    const names = ((await api("GET", "/api/backups")).json().backups as BackupDto[]).map(
      (b) => b.name,
    );
    expect(names).toContain(manual.name);
    expect(names).not.toContain(made[0]?.name);
    expect(names).toContain(made[1]?.name);
    expect(names).toContain(made[2]?.name);
    for (const n of names) await api("DELETE", `/api/backups/${n}`);
  });

  it("round-trips the database and data folder", async () => {
    const url = db as string;
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const [owner] = await sql`select id from users where email = 'owner@example.com'`;
    const [conv] = await sql`
      insert into conversations (user_id, title, session_files, updated_at)
      values (${owner?.id}, ${'Quotes "and" \\ back\nslashes ✓'}, ${sql.json({ captain: "/data/pi/s.jsonl" })},
              '2026-03-04 05:06:07.123456+00')
      returning id`;
    await sql`
      insert into messages (conversation_id, user_id, role, content, meta, created_at)
      values (${conv?.id}, ${owner?.id}, 'user', 'hi', ${'{"nested": {"a": [1, 2.5, null, "x"]}, "big": 12345678901234567890123.5}'}::text::jsonb,
              '2025-12-31 23:59:59.999999+00')`;
    await sql.unsafe(`insert into usage_events (model, cost_micro_usd, input_tokens, created_at)
      values ('faux/m', 9007199254740993, 1, '2026-01-02 03:04:05.000001+00')`);
    await sql`insert into settings (key, value) values ('roundtrip', ${sql.json({ s: "ü ", n: 0.1 })})`;
    await sql.end();

    // Data folder: nested files, a long path, an empty folder, a symlink, and workspaces.
    const longDir = join(dataDir, "skills", "a".repeat(60), "b".repeat(60));
    mkdirSync(longDir, { recursive: true });
    writeFileSync(join(longDir, "SKILL.md"), "long path ✓");
    mkdirSync(join(dataDir, "pi", "empty"), { recursive: true });
    writeFileSync(join(dataDir, "pi", "auth.json"), Buffer.from([0, 1, 2, 255]));
    symlinkSync("auth.json", join(dataDir, "pi", "auth-link"));
    mkdirSync(join(dataDir, "workspaces", "proj"), { recursive: true });
    writeFileSync(join(dataDir, "workspaces", "proj", "README"), "workspace");
    const secret = readFileSync(join(dataDir, ".secret"), "utf8");

    const before = await snapshot(url);
    const backup = (await api("POST", "/api/backups")).json().backup as BackupDto;
    const file = join(dataDir, "backups", backup.name);

    // Readable by the system tar, and the manifest describes it.
    const listing = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).split("\n");
    expect(listing[0]).toBe("manifest.json");
    expect(listing).toContain("data/.secret");
    expect(listing).toContain(`data/skills/${"a".repeat(60)}/${"b".repeat(60)}/SKILL.md`);
    expect(listing.some((l) => l.startsWith("data/workspaces"))).toBe(false);
    expect(listing.some((l) => l.startsWith("data/backups"))).toBe(false);
    const manifest = await readBackupManifest(file);
    expect(manifest.trigger).toBe("manual");
    expect(manifest.migrations.count).toBeGreaterThan(0);
    expect(manifest.tables.map((x) => x.name)).toEqual(backupTables());
    expect(manifest.tables.find((x) => x.name === "messages")?.rows).toBe(1);

    await t.app.close();

    // Wipe: schema gone, data folder changed.
    const wiped = postgres(url, { max: 1, onnotice: () => {} });
    await wiped.unsafe(
      "drop schema drizzle cascade; drop schema public cascade; create schema public;",
    );
    await wiped.end();
    rmSync(join(dataDir, "skills"), { recursive: true });
    rmSync(join(dataDir, "pi"), { recursive: true });
    writeFileSync(join(dataDir, ".secret"), "other");
    writeFileSync(join(dataDir, "stray.txt"), "should go");

    const result = await restoreBackup({
      url,
      dataDir,
      file,
      keep: [join(dataDir, "backups")],
    });
    expect(result.skippedTables).toEqual([]);
    expect(result.rows.messages).toBe(1);

    expect(await snapshot(url)).toEqual(before);
    expect(readFileSync(join(longDir, "SKILL.md"), "utf8")).toBe("long path ✓");
    expect(readFileSync(join(dataDir, "pi", "auth.json"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(readlinkSync(join(dataDir, "pi", "auth-link"))).toBe("auth.json");
    expect(existsSync(join(dataDir, "pi", "empty"))).toBe(true);
    expect(readFileSync(join(dataDir, ".secret"), "utf8")).toBe(secret);
    expect(existsSync(join(dataDir, "stray.txt"))).toBe(false);
    // Not in the backup, so this install's workspaces and the backups folder stay.
    expect(readFileSync(join(dataDir, "workspaces", "proj", "README"), "utf8")).toBe("workspace");
    expect(existsSync(file)).toBe(true);
    expect(readdirNames(dataDir).some((n) => n.startsWith(".restore-"))).toBe(false);

    // The server boots on the restored data and the owner can sign in.
    t = await reopen(url, dataDir);
    const login = await api(
      "POST",
      "/api/auth/login",
      { email: "owner@example.com", password: "correct horse" },
      "",
    );
    expect(login.statusCode).toBe(200);
  });

  it("refuses a backup from a newer schema, and anything that is not a backup", async () => {
    const work = mkdtempSync(join(tmpdir(), "shipmate-bk-"));
    const src = join(work, "src");
    mkdirSync(src);
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        format: 1,
        shipmateVersion: "9.9.9",
        migrations: { count: 999, last: "0999_future" },
        createdAt: new Date().toISOString(),
        trigger: "cli",
        includeWorkspaces: false,
        tables: [],
      }),
    );
    const future = join(work, "future.tar.gz");
    execFileSync("tar", ["-czf", future, "-C", src, "manifest.json"]);
    await expect(
      restoreBackup({ url: db as string, dataDir: join(work, "data"), file: future }),
    ).rejects.toThrow(/newer Shipmate/);

    writeFileSync(join(src, "other.txt"), "x");
    const junk = join(work, "junk.tar.gz");
    execFileSync("tar", ["-czf", junk, "-C", src, "other.txt"]);
    await expect(
      restoreBackup({ url: db as string, dataDir: join(work, "data"), file: junk }),
    ).rejects.toThrow(/not a Shipmate backup/);
    rmSync(work, { recursive: true, force: true });
  });
});

function readdirNames(dir: string): string[] {
  return execFileSync("ls", ["-a", dir], { encoding: "utf8" }).split("\n");
}

/** A fresh app on an existing database and data folder (no reset). */
async function reopen(url: string, dataDir: string) {
  const { loadConfig } = await import("./config.js");
  const { buildApp } = await import("./app.js");
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider } = await import("@earendil-works/pi-ai");
  const config = loadConfig({ DATABASE_URL: url, SHIPMATE_DATA_DIR: dataDir, SHIPMATE_MCP: "off" });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dataDir, "auth.json"),
    modelsPath: join(dataDir, "models.json"),
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const app = await buildApp(config, {
    modelRuntime,
    extraProviders: ["faux"],
    logger: false,
    watches: false,
  });
  await app.ready();
  return { app, faux, config };
}
