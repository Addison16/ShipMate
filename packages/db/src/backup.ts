import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";
import type { Db } from "./client.js";
import { connect } from "./connect.js";
import * as schema from "./schema.js";

/**
 * Backups: one .tar.gz holding
 *   manifest.json        BackupManifest (always the first entry)
 *   db/<table>.jsonl     one row per line, as Postgres' own to_jsonb(row) text (lossless:
 *                        timestamps keep their offset and microseconds, jsonb stays nested,
 *                        bigint/numeric keep every digit, bytea is "\\x…" hex)
 *   data/…               the data folder (workspaces/ only when asked for; the backups folder
 *                        itself and restore staging folders are always skipped)
 * The tar is plain ustar with PAX headers for long names, written and read here so no
 * external tool or dependency is needed.
 */

export const BACKUP_FORMAT = 1;

/** Folder under the data dir where the image keeps its bundled Postgres (docker/entrypoint.sh). */
export const BUNDLED_DB_DIR = "postgres";

export interface MigrationLevel {
  /** Number of applied migrations. */
  count: number;
  /** Tag of the newest applied migration, e.g. "0004_phase4"; null when unknown. */
  last: string | null;
}

export interface BackupManifest {
  format: number;
  shipmateVersion: string;
  migrations: MigrationLevel;
  createdAt: string;
  /** "manual" | "scheduled" | "cli" */
  trigger: string;
  includeWorkspaces: boolean;
  tables: Array<{ name: string; file: string; columns: string[]; rows: number }>;
}

export interface CreateBackupOptions {
  /** An open database (its postgres.js client is used), or a connection URL. */
  db?: Db;
  url?: string;
  dataDir: string;
  outFile: string;
  includeWorkspaces?: boolean;
  trigger?: string;
  /** Shipmate version recorded in the manifest. */
  version?: string;
  /** Absolute paths inside dataDir to leave out (e.g. the backups folder). */
  exclude?: string[];
}

export interface RestoreBackupOptions {
  url: string;
  dataDir: string;
  file: string;
  /** Absolute paths inside dataDir that the restore must leave alone (e.g. the backups folder). */
  keep?: string[];
}

export interface RestoreResult {
  manifest: BackupManifest;
  rows: Record<string, number>;
  /** Tables in the backup that this build no longer has (their rows were skipped). */
  skippedTables: string[];
}

// ---------- tables and migrations ----------

/** Every table in the Drizzle schema, parents before children (FK-safe insert order). */
export function backupTables(): string[] {
  const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const cfg = getTableConfig(t);
    const parents = new Set<string>();
    for (const fk of cfg.foreignKeys) {
      const parent = getTableConfig(fk.reference().foreignTable).name;
      if (parent !== cfg.name) parents.add(parent);
    }
    deps.set(cfg.name, parents);
  }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    const s = state.get(name);
    if (s === "done" || s === "visiting") return; // a cycle: break it here
    state.set(name, "visiting");
    for (const p of [...(deps.get(name) ?? [])].sort()) visit(p);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of [...deps.keys()].sort()) visit(name);
  return order;
}

interface Journal {
  entries: Array<{ idx: number; when: number; tag: string }>;
}

function readJournal(): Journal {
  const url = new URL("../drizzle/meta/_journal.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Journal;
}

/** The newest migration level this build knows. */
export function buildMigrationLevel(): MigrationLevel {
  const { entries } = readJournal();
  return { count: entries.length, last: entries.at(-1)?.tag ?? null };
}

/** The migration level a database is at (count 0 when it was never migrated). */
export async function databaseMigrationLevel(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<MigrationLevel> {
  const [exists] = await sql`select to_regclass('drizzle.__drizzle_migrations') is not null as ok`;
  if (!exists?.ok) return { count: 0, last: null };
  const [row] = await sql<Array<{ n: number; last: string | null }>>`
    select count(*)::int as n, max(created_at)::text as last from drizzle.__drizzle_migrations`;
  const count = row?.n ?? 0;
  const when = row?.last ? Number(row.last) : null;
  const tag = readJournal().entries.find((e) => e.when === when)?.tag ?? null;
  return { count, last: tag };
}

const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

async function tableColumns(sql: postgres.Sql | postgres.TransactionSql) {
  const rows = await sql<Array<{ table_name: string; column_name: string }>>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and is_generated = 'NEVER'
    order by table_name, ordinal_position`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.table_name) ?? [];
    list.push(r.column_name);
    out.set(r.table_name, list);
  }
  return out;
}

// ---------- backup ----------

/** Write a backup to `outFile` (via a `.partial` file renamed at the end). */
export async function createBackup(
  options: CreateBackupOptions,
): Promise<{ file: string; sizeBytes: number; manifest: BackupManifest }> {
  if (!options.db && !options.url) throw new Error("createBackup needs db or url");
  const own = options.db ? null : connect(options.url as string, { max: 1, onnotice: () => {} });
  const sql = (options.db?.$client ?? own) as postgres.Sql;
  const outFile = resolve(options.outFile);
  await mkdir(dirname(outFile), { recursive: true });
  const staging = await mkdtemp(join(dirname(outFile), ".backup-"));
  const partial = `${outFile}.partial`;
  try {
    const tables: BackupManifest["tables"] = [];
    let migrations: MigrationLevel = { count: 0, last: null };
    // One snapshot for every table, so the dump is consistent while the server keeps running.
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      migrations = await databaseMigrationLevel(tx);
      const columns = await tableColumns(tx);
      for (const name of backupTables()) {
        const cols = columns.get(name);
        if (!cols) continue; // not created yet in this database
        const file = `db/${name}.jsonl`;
        const out = createWriteStream(join(staging, `${name}.jsonl`));
        let rows = 0;
        const cursor = tx
          .unsafe<Array<{ j: string }>>(`select to_jsonb(t)::text as j from ${q(name)} t`)
          .cursor(500);
        for await (const batch of cursor) {
          const text = batch.map((r) => `${r.j}\n`).join("");
          rows += batch.length;
          if (!out.write(text)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
        await new Promise<void>((res, rej) =>
          out.end((err?: Error | null) => (err ? rej(err) : res())),
        );
        tables.push({ name, file, columns: cols, rows });
      }
    });

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      shipmateVersion: options.version ?? "unknown",
      migrations,
      createdAt: new Date().toISOString(),
      trigger: options.trigger ?? "manual",
      includeWorkspaces: options.includeWorkspaces ?? false,
      tables,
    };

    const dataDir = resolve(options.dataDir);
    const skip = new Set([
      outFile,
      partial,
      staging,
      ...(options.exclude ?? []).map((p) => resolve(p)),
    ]);
    if (!manifest.includeWorkspaces) skip.add(join(dataDir, "workspaces"));
    // The bundled database's files: its rows are already in the backup as tables.
    skip.add(join(dataDir, BUNDLED_DB_DIR));

    async function* entries(): AsyncGenerator<Buffer> {
      const now = Math.floor(Date.now() / 1000);
      const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      yield* tarFile(
        "manifest.json",
        body.length,
        0o644,
        now,
        (async function* () {
          yield body;
        })(),
      );
      for (const t of tables) {
        const path = join(staging, `${t.name}.jsonl`);
        const st = await stat(path);
        yield* tarFile(t.file, st.size, 0o644, now, readExactly(path, st.size));
      }
      yield* tarDir(dataDir, "data", skip);
      yield Buffer.alloc(1024); // end of archive
    }

    await pipeline(
      Readable.from(entries()),
      createGzip(),
      // A backup holds the whole database: only Shipmate's own user may read it.
      createWriteStream(partial, { mode: 0o600 }),
    );
    await rename(partial, outFile);
    const { size } = await stat(outFile);
    return { file: outFile, sizeBytes: size, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(partial, { force: true });
    if (own) await own.end({ timeout: 5 });
  }
}

/** The data folder, recursively; directories first so empty ones survive. */
async function* tarDir(root: string, prefix: string, skip: Set<string>): AsyncGenerator<Buffer> {
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return; // no data folder: nothing to add
  }
  for (const name of names) {
    const abs = join(root, name);
    if (skip.has(abs) || name.startsWith(".restore-") || name.startsWith(".backup-")) continue;
    const path = `${prefix}/${name}`;
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(abs);
    } catch {
      continue; // removed while we walked
    }
    const mtime = Math.floor(st.mtimeMs / 1000);
    if (st.isDirectory()) {
      yield tarHeader({ path: `${path}/`, size: 0, type: "5", mode: st.mode & 0o7777, mtime });
      yield* tarDir(abs, path, skip);
    } else if (st.isFile()) {
      yield* tarFile(path, st.size, st.mode & 0o7777, mtime, readExactly(abs, st.size));
    } else if (st.isSymbolicLink()) {
      const linkpath = await readlink(abs);
      yield tarHeader({ path, size: 0, type: "2", mode: 0o777, mtime, linkpath });
    }
    // sockets, fifos and devices are skipped
  }
}

async function* tarFile(
  path: string,
  size: number,
  mode: number,
  mtime: number,
  body: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  yield tarHeader({ path, size, type: "0", mode, mtime });
  for await (const chunk of body) yield chunk;
  const pad = (512 - (size % 512)) % 512;
  if (pad) yield Buffer.alloc(pad);
}

/** Exactly `size` bytes of a file (zero-filled or cut if it changed since stat). */
async function* readExactly(path: string, size: number): AsyncGenerator<Buffer> {
  let left = size;
  if (left > 0) {
    for await (const chunk of createReadStream(path, { end: size - 1 })) {
      const buf = chunk as Buffer;
      const part = buf.length > left ? buf.subarray(0, left) : buf;
      left -= part.length;
      yield part;
      if (left === 0) break;
    }
  }
  while (left > 0) {
    const n = Math.min(left, 65536);
    left -= n;
    yield Buffer.alloc(n);
  }
}

// ---------- tar format ----------

interface TarHeader {
  path: string;
  size: number;
  /** "0" file, "5" directory, "2" symlink */
  type: string;
  mode: number;
  mtime: number;
  linkpath?: string;
}

const MAX_OCTAL_SIZE = 0o77777777777;

function octal(buf: Buffer, offset: number, length: number, value: number) {
  buf.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function rawHeader(
  name: string,
  size: number,
  type: string,
  mode: number,
  mtime: number,
  link = "",
) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, Math.min(size, MAX_OCTAL_SIZE));
  octal(h, 136, 12, mtime);
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len++;
  return `${len}${body}`;
}

function fitsUstar(s: string) {
  return Buffer.byteLength(s) <= 100 && /^[\x20-\x7e]*$/.test(s);
}

/** A ustar header, preceded by a PAX header when the path, link or size do not fit. */
function tarHeader(e: TarHeader): Buffer {
  const pax: string[] = [];
  if (!fitsUstar(e.path)) pax.push(paxRecord("path", e.path));
  if (e.linkpath !== undefined && !fitsUstar(e.linkpath)) {
    pax.push(paxRecord("linkpath", e.linkpath));
  }
  if (e.size > MAX_OCTAL_SIZE) pax.push(paxRecord("size", String(e.size)));
  const header = rawHeader(
    Buffer.from(e.path)
      .subarray(0, 100)
      .toString("latin1")
      .replace(/[^\x20-\x7e]/g, "_"),
    e.size,
    e.type,
    e.mode,
    e.mtime,
    (e.linkpath ?? "").slice(0, 100).replace(/[^\x20-\x7e]/g, "_"),
  );
  if (!pax.length) return header;
  const body = Buffer.from(pax.join(""));
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([
    rawHeader("PaxHeader", body.length, "x", 0o644, e.mtime),
    body,
    pad,
    header,
  ]);
}

/** Pull exact byte counts out of a stream. */
class ByteReader {
  #it: AsyncIterator<Buffer>;
  #buf: Buffer = Buffer.alloc(0);
  #done = false;
  constructor(stream: AsyncIterable<Buffer>) {
    this.#it = stream[Symbol.asyncIterator]();
  }
  async #fill(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#it.next();
    if (next.done) {
      this.#done = true;
      return false;
    }
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, next.value]) : next.value;
    return true;
  }
  /** Up to `n` bytes (fewer only at end of stream). */
  async read(n: number): Promise<Buffer> {
    while (this.#buf.length < n && (await this.#fill())) {}
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(out.length);
    return out;
  }
  /** Whatever is buffered (at least 1 byte unless at end), at most `n`. */
  async some(n: number): Promise<Buffer> {
    if (!this.#buf.length) await this.#fill();
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(out.length);
    return out;
  }
  async close() {
    await this.#it.return?.();
  }
}

function cstr(buf: Buffer, start: number, length: number) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function parseOctal(buf: Buffer, start: number, length: number) {
  const s = cstr(buf, start, length).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number.parseInt(body.subarray(i, space).toString("ascii"), 10);
    if (!len) break;
    const record = body.subarray(space + 1, i + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

interface TarEntry extends TarHeader {
  /** Read the body in chunks; must be fully consumed (or skipped) before the next entry. */
  body: AsyncGenerator<Buffer>;
}

/** Walk a .tar.gz entry by entry. Stop early by breaking out of the loop. */
async function* readTarGz(file: string): AsyncGenerator<TarEntry> {
  const source = createReadStream(file);
  const gunzip = createGunzip();
  source.on("error", (err) => gunzip.destroy(err));
  const reader = new ByteReader(source.pipe(gunzip));
  try {
    let pax: Record<string, string> = {};
    let longName: string | null = null;
    while (true) {
      const h = await reader.read(512);
      if (h.length < 512 || h.every((b) => b === 0)) return;
      const type = String.fromCharCode(h[156] || 0x30);
      let size = parseOctal(h, 124, 12);
      if (pax.size) size = Number(pax.size);
      const padded = size + ((512 - (size % 512)) % 512);
      if (type === "x" || type === "g" || type === "L") {
        const body = await reader.read(padded);
        if (type === "x") pax = parsePax(body.subarray(0, size));
        if (type === "L") longName = cstr(body, 0, size);
        continue;
      }
      const prefix = cstr(h, 345, 155);
      const name = cstr(h, 0, 100);
      const path = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
      const linkpath = pax.linkpath ?? cstr(h, 157, 100);
      pax = {};
      longName = null;
      let left = size;
      const body = (async function* () {
        while (left > 0) {
          const chunk = await reader.some(left);
          if (!chunk.length) throw new Error("backup file is truncated");
          left -= chunk.length;
          yield chunk;
        }
      })();
      yield {
        path,
        size,
        type: type === "\0" ? "0" : type,
        mode: parseOctal(h, 100, 8),
        mtime: parseOctal(h, 136, 12),
        linkpath,
        body,
      };
      // Skip whatever the consumer left unread, then the padding.
      while (left > 0) {
        const chunk = await reader.some(left);
        if (!chunk.length) throw new Error("backup file is truncated");
        left -= chunk.length;
      }
      await reader.read(padded - size);
    }
  } finally {
    await reader.close();
  }
}

// ---------- restore ----------

/** runMigrations without Postgres' "already exists, skipping" notices on the console. */
async function migrateQuietly(url: string) {
  const sql = connect(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The manifest of a backup file (read from its first entry only). */
export async function readBackupManifest(file: string): Promise<BackupManifest> {
  for await (const entry of readTarGz(file)) {
    if (entry.path !== "manifest.json") break;
    const chunks: Buffer[] = [];
    for await (const c of entry.body) chunks.push(c);
    const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BackupManifest;
    if (typeof manifest.format !== "number" || !Array.isArray(manifest.tables)) break;
    return manifest;
  }
  throw new Error("not a Shipmate backup (no manifest.json)");
}

/** A tar path made safe, or null when it would land outside the target folder. */
function safePath(path: string): string | null {
  if (path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
  const norm = posix.normalize(path.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (!norm || norm === "." || norm.startsWith("../") || norm === "..") return null;
  if (norm.split("/").includes("..")) return null;
  return norm;
}

/**
 * Restore a backup: refuse a backup from a newer schema, migrate, replace every table's rows
 * in one transaction, then replace the data folder contents. Stop the server first.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreResult> {
  const file = resolve(options.file);
  const manifest = await readBackupManifest(file);
  if (manifest.format > BACKUP_FORMAT) {
    throw new Error(`backup format ${manifest.format} is newer than this Shipmate understands`);
  }
  const build = buildMigrationLevel();
  if (manifest.migrations.count > build.count) {
    throw new Error(
      `backup is from a newer Shipmate (schema ${manifest.migrations.last ?? manifest.migrations.count}, this build has ${build.last ?? build.count}); upgrade Shipmate first`,
    );
  }

  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  const staging = await mkdtemp(join(dataDir, ".restore-"));
  try {
    // 1. Unpack into a staging folder next to the data (same filesystem, so moves are renames).
    const links: Array<{ path: string; target: string }> = [];
    const dirTimes: Array<{ path: string; mtime: number }> = [];
    for await (const entry of readTarGz(file)) {
      const rel = safePath(entry.path);
      if (!rel || !(rel === "manifest.json" || rel.startsWith("db/") || rel.startsWith("data/"))) {
        continue;
      }
      const abs = join(staging, ...rel.split("/"));
      if (entry.type === "5") {
        await mkdir(abs, { recursive: true, mode: entry.mode || 0o755 });
        dirTimes.push({ path: abs, mtime: entry.mtime });
      } else if (entry.type === "0" || entry.type === "7") {
        await mkdir(dirname(abs), { recursive: true });
        const fh = await open(abs, "w", entry.mode || 0o644);
        try {
          for await (const chunk of entry.body) await fh.write(chunk);
        } finally {
          await fh.close();
        }
        await utimes(abs, entry.mtime, entry.mtime).catch(() => {});
      } else if (entry.type === "2" && entry.linkpath) {
        // Created after every file, so no file is ever written through a link.
        links.push({ path: abs, target: entry.linkpath });
      }
    }
    for (const l of links) {
      await mkdir(dirname(l.path), { recursive: true });
      await symlink(l.target, l.path).catch(() => {});
    }
    for (const d of dirTimes.reverse()) await utimes(d.path, d.mtime, d.mtime).catch(() => {});

    // 2. Database: migrate, then swap every table's rows in one transaction.
    await migrateQuietly(options.url);
    const sql = connect(options.url, { max: 1, onnotice: () => {} });
    const rows: Record<string, number> = {};
    const skippedTables: string[] = [];
    try {
      await sql.begin(async (tx) => {
        const columns = await tableColumns(tx);
        const order = backupTables().filter((t) => columns.has(t));
        if (order.length) {
          await tx.unsafe(`truncate ${order.map(q).join(", ")} restart identity cascade`);
        }
        const byName = new Map(manifest.tables.map((t) => [t.name, t]));
        for (const t of manifest.tables) if (!order.includes(t.name)) skippedTables.push(t.name);
        for (const name of order) {
          const t = byName.get(name);
          if (!t) continue;
          const current = new Set(columns.get(name));
          const cols = t.columns
            .filter((c) => current.has(c))
            .map(q)
            .join(", ");
          const path = join(staging, ...(safePath(t.file) ?? "").split("/"));
          if (!cols || !safePath(t.file)) continue;
          const insert = `insert into ${q(name)} (${cols}) select ${cols} from jsonb_populate_recordset(null::${q(name)}, $1::text::jsonb)`;
          let batch: string[] = [];
          let bytes = 0;
          let count = 0;
          const flush = async () => {
            if (!batch.length) return;
            await tx.unsafe(insert, [`[${batch.join(",")}]`]);
            count += batch.length;
            batch = [];
            bytes = 0;
          };
          const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
          for await (const line of lines) {
            if (!line.trim()) continue;
            batch.push(line);
            bytes += line.length;
            if (batch.length >= 500 || bytes > 8_000_000) await flush();
          }
          await flush();
          rows[name] = count;
        }
        // Serial/identity columns continue after the restored rows.
        const seqs = await tx<Array<{ t: string; c: string; seq: string }>>`
          select table_name as t, column_name as c,
                 pg_get_serial_sequence(quote_ident(table_name), column_name) as seq
          from information_schema.columns
          where table_schema = 'public'
            and pg_get_serial_sequence(quote_ident(table_name), column_name) is not null`;
        for (const s of seqs) {
          await tx.unsafe(
            `select setval($1, coalesce((select max(${q(s.c)}) from ${q(s.t)}), 0) + 1, false)`,
            [s.seq],
          );
        }
      });
    } finally {
      await sql.end({ timeout: 5 });
    }

    // 3. Data folder: replace its contents, leaving protected paths alone.
    // Never the bundled database's files: it is the database being restored into.
    const keep = new Set<string>([staging, join(dataDir, BUNDLED_DB_DIR)]);
    for (const p of [...(options.keep ?? []), file]) {
      const rel = relative(dataDir, resolve(p));
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        keep.add(join(dataDir, rel.split(sep)[0] as string));
      }
    }
    if (!manifest.includeWorkspaces) keep.add(join(dataDir, "workspaces"));
    for (const name of await readdir(dataDir)) {
      const abs = join(dataDir, name);
      if (!keep.has(abs)) await rm(abs, { recursive: true, force: true });
    }
    const unpacked = join(staging, "data");
    const restored = await readdir(unpacked).catch(() => [] as string[]);
    for (const name of restored) {
      const target = join(dataDir, name);
      if (keep.has(target)) continue; // protected (e.g. workspaces kept from this install)
      await rename(join(unpacked, name), target);
    }
    return { manifest, rows, skippedTables };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ---------- file names ----------

/** Backup files are listed, downloaded and deleted only when their name matches this. */
export const BACKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.tar\.gz$/;

/** "shipmate-2026-10-11T030000Z-scheduled.tar.gz" (UTC, sortable). */
export function backupFileName(trigger: string, date = new Date(), n = 1): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "");
  return `shipmate-${stamp}-${trigger}${n > 1 ? `-${n}` : ""}.tar.gz`;
}

/** The trigger encoded in a backup file name ("manual" when the name does not say). */
export function backupTrigger(name: string): string {
  return /-(manual|scheduled|cli)(-\d+)?\.tar\.gz$/.exec(name)?.[1] ?? "manual";
}
