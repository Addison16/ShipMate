import { statfs } from "node:fs/promises";
import type {
  BackupDto,
  BackupSettingsDto,
  ChatGptStatusDto,
  HealthCheckDto,
  HealthStatus,
  ShipyardStatusDto,
} from "@shipmate/core";
import { CODEX_SIGN_IN_COMMAND } from "@shipmate/crew";
import { buildMigrationLevel, type Db, databaseMigrationLevel } from "@shipmate/db";
import { type ProviderRecord, probeModels, SELF_HOSTED_KINDS } from "@shipmate/providers";

type Check = HealthCheckDto;
const check = (
  id: string,
  group: string,
  name: string,
  status: HealthStatus,
  detail: string,
  hint: string | null = null,
): Check => ({ id, group, name, status, detail, hint: status === "ok" ? null : hint });

/** What the checks read; each part is a small, existing status call. */
export interface HealthDeps {
  db: Db;
  dataDir: string;
  /** SHIPMATE_URL, compared with the address the browser used. */
  publicUrl: string;
  providers: () => Promise<ProviderRecord[]>;
  chatgpt: () => Promise<ChatGptStatusDto>;
  /** Crew backends in use, to decide whether the Claude Code CLI matters. */
  claudeCli: () => Promise<{ used: boolean; installed: boolean; signedIn: boolean }>;
  /** The Codex CLI, checked only when a crew member runs on it. Optional for older callers. */
  codexCli?: () => Promise<{ used: boolean; installed: boolean; signedIn: boolean }>;
  bridges: Array<{
    id: string;
    name: string;
    status: () => Promise<{ configured: boolean; connected: boolean; error: string | null }>;
  }>;
  /** The Shipyard's own check of the Docker socket (no Docker calls of our own). */
  sandbox: () => Promise<ShipyardStatusDto>;
  backups: () => Promise<{ list: BackupDto[]; settings: BackupSettingsDto }>;
  /** Free space of the data folder; injectable for tests. */
  disk?: (dir: string) => Promise<{ free: number; total: number }>;
  fetchImpl?: typeof fetch;
  /** API roots per provider kind (tests point these at a fake). */
  providerApis?: Partial<Record<string, string>>;
  now?: () => Date;
}

/** Where each API-key provider answers a free, authenticated request. */
export const PROVIDER_APIS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  xai: "https://api.x.ai",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai",
};

/**
 * Check an API key with a free request (a model list or key info): never a model call.
 * Returns ok, the key was refused, or the service could not be reached.
 */
export async function checkApiKey(
  kind: string,
  key: string,
  options: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ status: HealthStatus; detail: string }> {
  const base = (options.base ?? PROVIDER_APIS[kind] ?? "").replace(/\/+$/, "");
  if (!base) return { status: "ok", detail: "Key stored (no free check for this provider)" };
  let url = `${base}/v1/models`;
  const headers: Record<string, string> = {};
  if (kind === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    url = `${base}/v1/models?limit=1`;
  } else if (kind === "google") {
    // A header, not ?key=, so the key never lands in proxy or URL logs.
    headers["x-goog-api-key"] = key;
    url = `${base}/v1beta/models?pageSize=1`;
  } else if (kind === "openrouter") {
    url = `${base}/api/v1/key`;
    headers.authorization = `Bearer ${key}`;
  } else {
    headers.authorization = `Bearer ${key}`;
  }
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { status: "ok", detail: "Reachable, key accepted" };
    if (res.status === 401 || res.status === 403 || (kind === "google" && res.status === 400)) {
      return { status: "fail", detail: `The key was refused (${res.status})` };
    }
    if (res.status === 429) return { status: "warn", detail: "Reachable, but rate limited now" };
    return { status: "warn", detail: `Reachable, but it answered ${res.status}` };
  } catch (err) {
    const e = err as Error;
    return {
      status: "fail",
      detail: e.name === "TimeoutError" ? `${base} did not answer in time` : `Cannot reach ${base}`,
    };
  }
}

const GiB = 1024 ** 3;
export function formatBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

function ago(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return "less than an hour ago";
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Run a check with a time limit, turning surprises into a failed row instead of an error. */
async function guarded(
  fallback: Pick<Check, "id" | "group" | "name">,
  run: () => Promise<Check[]>,
): Promise<Check[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<Check[]>((resolve) => {
        timer = setTimeout(
          () =>
            resolve([
              check(fallback.id, fallback.group, fallback.name, "fail", "The check timed out"),
            ]),
          10_000,
        );
      }),
    ]);
  } catch (err) {
    return [
      check(fallback.id, fallback.group, fallback.name, "fail", (err as Error).message || "error"),
    ];
  } finally {
    clearTimeout(timer);
  }
}

/** The address a request reached Shipmate at, as the browser saw it (after trusted proxies). */
export interface SeenAddress {
  protocol: string;
  host: string;
  /** Whether a proxy in front claimed the request (X-Forwarded-* present). */
  forwarded: boolean;
}

/** Everything the Health page lists, run in parallel. */
export async function runChecks(d: HealthDeps, seen?: SeenAddress): Promise<Check[]> {
  const groups = await Promise.all([
    guarded({ id: "database", group: "Database", name: "Database" }, () => database(d)),
    guarded({ id: "providers", group: "Models", name: "Model providers" }, () => providers(d)),
    guarded({ id: "bridges", group: "Chat bridges", name: "Chat bridges" }, () => bridges(d)),
    guarded({ id: "sandbox", group: "Shipyard", name: "Docker socket" }, () => sandbox(d)),
    guarded({ id: "disk", group: "Storage", name: "Disk space" }, () => disk(d)),
    guarded({ id: "backups", group: "Storage", name: "Backups" }, () => backups(d)),
    Promise.resolve(seen ? [addressCheck(d.publicUrl, seen)] : []),
  ]);
  return groups.flat();
}

/**
 * SHIPMATE_URL against the address the page was opened at. Links in notifications, webhooks,
 * sign-in redirects and Secure cookies all follow SHIPMATE_URL, so a mismatch shows up as
 * broken sign-ins or links long before anyone thinks of the setting.
 */
export function addressCheck(publicUrl: string, seen: SeenAddress): Check {
  const G = "Web address";
  const name = "Shipmate's address";
  let want: URL;
  try {
    want = new URL(publicUrl);
  } catch {
    return check("address", G, name, "fail", `SHIPMATE_URL is not a URL: ${publicUrl}`, "Set it.");
  }
  // Links are built by appending paths, so a query or fragment (even an empty "?" or "#")
  // would swallow them.
  if (/[?#]/.test(publicUrl)) {
    return check(
      "address",
      G,
      name,
      "warn",
      `SHIPMATE_URL has a query or fragment (${publicUrl})`,
      "Set SHIPMATE_URL to the plain address, e.g. https://shipmate.example.com, and restart.",
    );
  }
  if (want.pathname !== "/") {
    return check(
      "address",
      G,
      name,
      "warn",
      `SHIPMATE_URL has a path (${want.pathname})`,
      "Shipmate must be served at the root of its own address, e.g. https://shipmate.example.com, not https://example.com/shipmate. Give it its own subdomain on the proxy.",
    );
  }
  const opened = `${seen.protocol}://${seen.host}`;
  let got: URL | null = null;
  try {
    got = new URL(opened);
  } catch {
    got = null;
  }
  if (got && got.origin === want.origin) {
    return check("address", G, name, "ok", `Opened at ${want.origin}, matching SHIPMATE_URL`);
  }
  // https outside, plain http inside: the proxy's forwarded headers were not believed.
  if (got && want.protocol === "https:" && got.protocol === "http:" && got.host === want.host) {
    return check(
      "address",
      G,
      name,
      "warn",
      `SHIPMATE_URL is ${want.origin}, but Shipmate saw this page arrive over plain http`,
      seen.forwarded
        ? "Your reverse proxy sends X-Forwarded-Proto, but from an address Shipmate does not trust. Add the proxy's IP or network to SHIPMATE_TRUST_PROXY."
        : "Have the reverse proxy send X-Forwarded-Proto (see docs/reverse-proxy.md), and check SHIPMATE_TRUST_PROXY covers it.",
    );
  }
  return check(
    "address",
    G,
    name,
    "warn",
    `This page was opened at ${opened}, but SHIPMATE_URL is ${want.origin}`,
    want.protocol === "https:" && got?.protocol === "http:"
      ? "Sign-in only works at the SHIPMATE_URL address (its cookies are https-only). Open Shipmate there, or change SHIPMATE_URL and restart."
      : "Links, webhooks and sign-in redirects use SHIPMATE_URL. If people open Shipmate at this address, set SHIPMATE_URL to it and restart.",
  );
}

async function database(d: HealthDeps): Promise<Check[]> {
  const sql = d.db.$client;
  const started = Date.now();
  const [v] = await sql<Array<{ v: string }>>`select current_setting('server_version') as v`;
  const ms = Date.now() - started;
  const version = (v?.v ?? "").split(" ")[0];
  const out = [
    check(
      "database",
      "Database",
      "Postgres",
      ms > 1000 ? "warn" : "ok",
      `Postgres ${version}, answered in ${ms} ms`,
      "The database is slow to answer; check the host's load and disk.",
    ),
  ];
  const have = await databaseMigrationLevel(sql);
  const want = buildMigrationLevel();
  if (have.count === want.count) {
    out.push(
      check(
        "migrations",
        "Database",
        "Migrations",
        "ok",
        `Up to date (${want.count}, latest ${want.last ?? "none"})`,
      ),
    );
  } else if (have.count < want.count) {
    out.push(
      check(
        "migrations",
        "Database",
        "Migrations",
        "warn",
        `${have.count} of ${want.count} applied`,
        "Migrations run when Shipmate starts; restart it to apply the rest.",
      ),
    );
  } else {
    out.push(
      check(
        "migrations",
        "Database",
        "Migrations",
        "fail",
        `The database has ${have.count} migrations; this Shipmate knows ${want.count}`,
        "The database was used by a newer Shipmate. Update Shipmate to that version or newer.",
      ),
    );
  }
  return out;
}

async function providers(d: HealthDeps): Promise<Check[]> {
  const G = "Models";
  const [records, chatgpt, cli, codex] = await Promise.all([
    d.providers(),
    d.chatgpt(),
    d.claudeCli(),
    d.codexCli?.() ?? { used: false, installed: false, signedIn: false },
  ]);
  const out = await Promise.all(
    records.map(async (r): Promise<Check> => {
      const id = `provider:${r.id}`;
      if (!r.enabled) {
        return check(id, G, r.label, "warn", "Disabled", "Enable it on the Providers page.");
      }
      if (SELF_HOSTED_KINDS.includes(r.kind)) {
        const base = r.baseUrl ?? "";
        try {
          const served = await probeModels(base, r.apiKey, d.fetchImpl);
          const missing = r.models.filter((m) => !served.includes(m));
          if (missing.length) {
            return check(
              id,
              G,
              r.label,
              "warn",
              `Reachable, but it does not serve ${missing.join(", ")}`,
              "Download the model on the server, or update the model list on the Providers page.",
            );
          }
          return check(
            id,
            G,
            r.label,
            r.models.length ? "ok" : "warn",
            `Reachable at ${base}, ${served.length} model${served.length === 1 ? "" : "s"} served`,
            "No models are picked for it yet; use Probe models on the Providers page.",
          );
        } catch {
          return check(
            id,
            G,
            r.label,
            "fail",
            `Cannot reach ${base}`,
            "Is the model server running and reachable from Shipmate's container?",
          );
        }
      }
      if (!r.apiKey) {
        return check(id, G, r.label, "fail", "No API key stored", "Add the key on Providers.");
      }
      const res = await checkApiKey(r.kind, r.apiKey, {
        ...(d.providerApis?.[r.kind] ? { base: d.providerApis[r.kind] } : {}),
        ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
      });
      return check(
        id,
        G,
        r.label,
        res.status,
        res.detail,
        res.status === "fail" && res.detail.startsWith("The key")
          ? "Replace the key on the Providers page."
          : "Check Shipmate's internet access, or the provider's status page.",
      );
    }),
  );
  if (chatgpt.signedIn || chatgpt.lastError) {
    out.push(
      check(
        "provider:chatgpt",
        G,
        "ChatGPT plan",
        chatgpt.lastError ? "fail" : "ok",
        chatgpt.lastError ?? `Signed in${chatgpt.email ? ` as ${chatgpt.email}` : ""}`,
        "Sign in with ChatGPT again on the Providers page.",
      ),
    );
  }
  if (cli.used) {
    out.push(
      check(
        "provider:claude-code-cli",
        G,
        "Claude Code CLI",
        cli.installed && cli.signedIn ? "ok" : cli.installed ? "warn" : "fail",
        !cli.installed
          ? "Not installed"
          : cli.signedIn
            ? "Installed and signed in"
            : "Not signed in",
        "Crew use the Claude Code CLI backend. Sign in with `docker exec -it shipmate claude`.",
      ),
    );
  }
  if (codex.used) {
    out.push(
      check(
        "provider:codex-cli",
        G,
        "Codex CLI",
        codex.installed && codex.signedIn ? "ok" : codex.installed ? "warn" : "fail",
        !codex.installed
          ? "Not installed"
          : codex.signedIn
            ? "Installed and signed in"
            : "Not signed in",
        `Crew use the Codex engine. Sign in with \`${CODEX_SIGN_IN_COMMAND}\`.`,
      ),
    );
  }
  if (out.length === 0) {
    out.push(
      check(
        "providers",
        G,
        "Model providers",
        "fail",
        "None set up, so the crew cannot answer",
        "Add an API key on Providers, or run a local model (Providers → Local model).",
      ),
    );
  }
  return out;
}

async function bridges(d: HealthDeps): Promise<Check[]> {
  const out: Check[] = [];
  for (const b of d.bridges) {
    const s = await b.status();
    if (!s.configured) continue;
    out.push(
      check(
        `bridge:${b.id}`,
        "Chat bridges",
        b.name,
        s.connected ? "ok" : "fail",
        s.connected ? "Connected" : (s.error ?? "Not connected"),
        `Check the token on the ${b.name} page; Shipmate reconnects when it is saved.`,
      ),
    );
  }
  return out;
}

async function sandbox(d: HealthDeps): Promise<Check[]> {
  const s = await d.sandbox();
  return [
    check(
      "sandbox",
      "Shipyard",
      "Docker socket",
      s.available ? "ok" : "warn",
      s.available
        ? `Sandboxes can run (default image ${s.sandboxImage})`
        : (s.reason ?? "Unavailable"),
      "Only the Shipyard and one-click updates need it.",
    ),
  ];
}

async function disk(d: HealthDeps): Promise<Check[]> {
  const read =
    d.disk ??
    (async (dir: string) => {
      const s = await statfs(dir);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    });
  const { free, total } = await read(d.dataDir);
  const share = total > 0 ? free / total : 1;
  const status: HealthStatus = free < GiB ? "fail" : free < 5 * GiB || share < 0.1 ? "warn" : "ok";
  return [
    check(
      "disk",
      "Storage",
      "Disk space",
      status,
      `${formatBytes(free)} free of ${formatBytes(total)} at ${d.dataDir}`,
      "Free some space: old backups, Shipyard workspaces, or unused local models.",
    ),
  ];
}

async function backups(d: HealthDeps): Promise<Check[]> {
  const { list, settings } = await d.backups();
  const now = (d.now?.() ?? new Date()).getTime();
  const newest = list[0];
  const scheduled = settings.hourUtc !== null;
  if (!newest) {
    return [
      check(
        "backups",
        "Storage",
        "Backups",
        "warn",
        scheduled
          ? `None yet; the nightly backup runs at ${String(settings.hourUtc).padStart(2, "0")}:00 UTC`
          : "None, and the nightly schedule is off",
        "Back up now from Settings → Backups.",
      ),
    ];
  }
  const age = now - new Date(newest.createdAt).getTime();
  const tooOld = age > (scheduled ? 2 : 7) * 86_400_000;
  return [
    check(
      "backups",
      "Storage",
      "Backups",
      tooOld ? "warn" : "ok",
      `Last one ${ago(age)} (${newest.name}), ${list.length} kept`,
      scheduled
        ? "The nightly backup has not run lately; check the server log and the backups folder's free space."
        : "The nightly schedule is off; back up now or turn it on in Settings → Backups.",
    ),
  ];
}
