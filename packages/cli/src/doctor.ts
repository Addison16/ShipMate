import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { buildMigrationLevel, createDb, databaseMigrationLevel } from "@shipmate/db";
import { backupDir, dataDir, formatBytes } from "./env.js";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const LABEL: Record<Status, string> = { ok: "ok  ", warn: "WARN", fail: "FAIL" };

/** Check what a Shipmate install needs; exits 1 when something required fails. */
export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => {
    checks.push({ name, status, detail });
    console.log(`${LABEL[status]} ${name} (${detail})`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  add("node >= 22", major >= 22 ? "ok" : "fail", process.versions.node);

  // Database: reachable, migrations, size (for the disk check below).
  let dbBytes = 0;
  let storedSecrets = 0;
  const url = process.env.DATABASE_URL;
  if (!url) {
    add("database reachable", "fail", "DATABASE_URL is not set");
  } else {
    const { sql, close } = createDb(url);
    try {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        sql`select 1`,
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("timed out after 5s")), 5000);
        }),
      ]).finally(() => clearTimeout(timer));
      add("database reachable", "ok", redact(url));
      const have = await databaseMigrationLevel(sql);
      const want = buildMigrationLevel();
      if (have.count === want.count) {
        add("migrations up to date", "ok", want.last ?? String(want.count));
      } else if (have.count < want.count) {
        add(
          "migrations up to date",
          "warn",
          `${have.count}/${want.count} applied; the server applies the rest on start (or run shipmate migrate)`,
        );
      } else {
        add(
          "migrations up to date",
          "fail",
          `database has ${have.count} migrations, this Shipmate knows ${want.count}; upgrade Shipmate`,
        );
      }
      const [size] = await sql`select pg_database_size(current_database())::bigint as n`;
      dbBytes = Number(size?.n ?? 0);
      const [secrets] = await sql`select to_regclass('public.secrets') is not null as ok`;
      if (secrets?.ok) {
        const [n] = await sql`select count(*)::int as n from secrets`;
        storedSecrets = Number(n?.n ?? 0);
      }
    } catch (err) {
      add("database reachable", "fail", `${redact(url)}: ${(err as Error).message}`);
    } finally {
      await close().catch(() => {});
    }
  }

  // Data folder writable.
  const data = dataDir();
  try {
    await mkdir(data, { recursive: true });
    const probe = join(data, `.doctor-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    add("data folder writable", "ok", data);
  } catch (err) {
    add("data folder writable", "fail", `${data}: ${(err as Error).message}`);
  }

  // The key that decrypts stored secrets.
  const secretFile = join(data, ".secret");
  if (process.env.SHIPMATE_SECRET) {
    add("encryption key", "ok", "SHIPMATE_SECRET is set");
  } else if (existsSync(secretFile) && readable(secretFile)) {
    add("encryption key", "ok", `${secretFile}`);
  } else if (storedSecrets > 0) {
    add(
      "encryption key",
      "fail",
      `${storedSecrets} stored secrets but no SHIPMATE_SECRET or ${secretFile}; restore the key`,
    );
  } else {
    add("encryption key", "warn", `none yet; the server creates ${secretFile} on first start`);
  }

  // Docker socket (optional: the Shipyard's sandboxes).
  const socket = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
  const ping = await dockerPing(socket);
  add(
    "docker socket",
    ping === true ? "ok" : "warn",
    ping === true ? socket : `${socket}: ${ping}; the Shipyard stays off without it`,
  );

  // Room for backups: the database dump plus the data folder, compressed; ask for 2x the DB.
  const dir = backupDir();
  try {
    const fs = await statfs(existingParent(dir));
    const free = fs.bavail * fs.bsize;
    const want = Math.max(1024 ** 3, dbBytes * 2);
    add(
      "disk space for backups",
      free >= want ? "ok" : "warn",
      `${formatBytes(free)} free at ${dir}${free >= want ? "" : `, want at least ${formatBytes(want)}`}`,
    );
  } catch (err) {
    add("disk space for backups", "warn", `${dir}: ${(err as Error).message}`);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  console.log(
    failed
      ? `\n${failed} problem(s) to fix`
      : warned
        ? `\nok, with ${warned} warning(s)`
        : "\nall good",
  );
  process.exitCode = failed ? 1 : 0;
}

function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

function readable(file: string): boolean {
  try {
    return readFileSync(file, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function existingParent(path: string): string {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

/** true, or why the Docker API did not answer. */
function dockerPing(socketPath: string): Promise<true | string> {
  if (!existsSync(socketPath)) return Promise.resolve("not mounted");
  return new Promise((done) => {
    const req = request({ socketPath, path: "/_ping", method: "GET", timeout: 3000 }, (res) => {
      res.resume();
      done(res.statusCode === 200 ? true : `answered ${res.statusCode}`);
    });
    req.on("timeout", () => {
      req.destroy();
      done("timed out");
    });
    req.on("error", (err) => done(err.message));
    req.end();
  });
}
