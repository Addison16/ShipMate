import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { CrewBundle, CrewDetailDto, CrewImportPreviewDto, CrewManifest } from "@shipmate/core";
import { CREW_FILES, CrewSlug, DEFAULT_MODEL } from "@shipmate/core";
import { CrewValidationError, parseManifestYaml, parseSkill, SkillError } from "@shipmate/crew";
import { loadCatalog } from "@shipmate/mcp-catalog";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { HttpError, type UserRow } from "../auth.js";
import type { CrewService } from "./crew.js";
import type { McpService } from "./mcp.js";
import type { ProviderService } from "./providers.js";
import type { SettingsService } from "./settings.js";
import type { SkillService } from "./skills.js";

/** Largest bundle accepted, as text or from a URL. */
export const MAX_BUNDLE_BYTES = 512 * 1024;
const MAX_SKILLS = 30;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const CrewBundleSchema = z.object({
  format: z.literal("shipmate-crew"),
  version: z.literal(1),
  slug: CrewSlug,
  manifest: z.string().min(1).max(20_000),
  persona: z.string().max(100_000),
  skills: z
    .array(
      z.object({
        name: z.string().regex(SKILL_NAME, "skill names are lowercase letters, digits and dashes"),
        content: z.string().min(1).max(50_000),
      }),
    )
    .max(MAX_SKILLS)
    .default([]),
  exportedAt: z.string().max(40).optional(),
});

/**
 * Patterns for values that look like credentials. Shared crew files should never carry them;
 * on export they are replaced, on import they are flagged.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/-]{24,}=*/g,
];

/** Replace anything that looks like a credential; returns the text and how many were found. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return "[redacted]";
    });
  }
  return { text: out, count };
}

/**
 * The shareable form of a manifest: what the crew member is, without anything that belongs to
 * this instance (approvals already granted, spend caps, skill auto-approval, the captain flag,
 * the pet).
 */
export function shareableManifest(m: CrewManifest): Record<string, unknown> {
  const {
    allow: _allow,
    monthlyCapUsd: _cap,
    autoApproveSkills: _auto,
    captain: _captain,
    avatar: _avatar,
    // The pet's picture stays on this instance, so its settings would point at nothing.
    pet: _pet,
    visibility: _visibility,
    ...rest
  } = m;
  return rest;
}

/**
 * Crew import and export: one crew member as a single file (crew.yaml + CREW.md + skills) that
 * people can pass around. Exports leave out memory and instance settings and scrub anything that
 * looks like a key; imports are validated, size-limited, and land as pending review.
 */
export class CrewBundleService {
  constructor(
    private readonly deps: {
      crew: CrewService;
      settings: SettingsService;
      providers: ProviderService;
      mcp: McpService;
      skills: SkillService;
      /** Fetch a bundle from a URL; replaceable in tests. */
      fetchUrl?: (url: string) => Promise<string>;
    },
  ) {}

  export(slug: string): { bundle: CrewBundle; redacted: number } {
    const folder = this.deps.crew.folder(slug);
    let redacted = 0;
    const scrub = (t: string) => {
      const r = redactSecrets(t);
      redacted += r.count;
      return r.text;
    };
    const skillsDir = join(folder.dir, CREW_FILES.skillsDir);
    const skills: CrewBundle["skills"] = [];
    if (existsSync(skillsDir)) {
      for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
        const file = join(skillsDir, d.name, "SKILL.md");
        if (!d.isDirectory() || !SKILL_NAME.test(d.name) || !existsSync(file)) continue;
        const content = readFileSync(file, "utf8");
        try {
          if (parseSkill(content).name !== d.name) continue;
        } catch {
          continue;
        }
        skills.push({ name: d.name, content: scrub(content) });
      }
    }
    const bundle: CrewBundle = {
      format: "shipmate-crew",
      version: 1,
      slug: folder.slug,
      manifest: scrub(stringifyYaml(shareableManifest(folder.manifest))),
      persona: scrub(folder.persona),
      skills: skills.slice(0, MAX_SKILLS),
      exportedAt: new Date().toISOString(),
    };
    return { bundle, redacted };
  }

  /** Read a bundle from pasted or uploaded text, or an https URL, and describe what it adds. */
  async preview(input: {
    text?: string | undefined;
    url?: string | undefined;
  }): Promise<CrewImportPreviewDto> {
    let raw: string;
    if (input.url) raw = await (this.deps.fetchUrl ?? fetchBundleText)(input.url);
    else if (input.text) raw = input.text;
    else throw new HttpError(400, "give the file's contents or a URL");
    if (Buffer.byteLength(raw, "utf8") > MAX_BUNDLE_BYTES) {
      throw new HttpError(400, "that file is too large for a crew member (512 KB at most)");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "that is not a Shipmate crew file (expected JSON)");
    }
    const { bundle, manifest } = this.#clean(json);
    const warnings: string[] = [];

    const available = await this.deps.providers.available();
    const usable =
      manifest.model === DEFAULT_MODEL ||
      available.some((m) => `${m.provider}/${m.id}` === manifest.model);
    const { defaultModel } = await this.deps.settings.get();
    const model = usable ? manifest.model : defaultModel;

    const catalog = new Map(loadCatalog().map((e) => [e.id, e]));
    const servers = new Map((await this.deps.mcp.list()).map((s) => [s.id, s]));
    const mcp = manifest.mcp.map((id) => ({
      id,
      known: catalog.has(id) || servers.has(id),
      installed: servers.get(id)?.installed ?? false,
    }));
    const unknown = mcp.filter((m) => !m.known).map((m) => m.id);
    if (unknown.length) {
      warnings.push(
        `It lists MCP servers this instance does not know (${unknown.join(", ")}); they will be skipped until added.`,
      );
    }
    // No tool list means all of pi's built-in tools, the shell included.
    if (!manifest.tools.length || manifest.tools.includes("bash")) {
      warnings.push(
        `It ${manifest.tools.length ? "asks for" : "gets every built-in tool, including"} a shell (bash). Shell commands still wait for approval.`,
      );
    }
    if (manifest.approval === "auto") {
      warnings.push(
        "Its approval policy is auto: it would run consequential tools without asking.",
      );
    }
    if (manifest.backend === "claude-code-cli") {
      const allowed = manifest.cli?.allowedTools ?? [];
      warnings.push(
        `It runs on the Claude Code CLI${allowed.length ? ` and may use ${allowed.join(", ")} without asking` : ""}.`,
      );
    }
    if (manifest.backend === "codex-cli") {
      const sandbox = manifest.codex?.sandbox ?? "read-only";
      warnings.push(
        `It runs on Codex${sandbox === "read-only" ? "" : ` and may ${sandbox === "workspace-write" ? "change files in its folder" : "run any command"}`}.`,
      );
    }
    let flagged = redactSecrets(bundle.persona).count + redactSecrets(bundle.manifest).count;
    for (const s of bundle.skills) flagged += redactSecrets(s.content).count;
    if (flagged) {
      warnings.push(
        `It contains ${flagged} value${flagged === 1 ? "" : "s"} that look like keys or tokens. Read the persona and skills before importing.`,
      );
    }

    const skills = bundle.skills.map((s) => ({
      name: s.name,
      description: parseSkill(s.content).description,
    }));
    return {
      bundle,
      name: manifest.name,
      role: manifest.role,
      model,
      modelReplaced: usable ? null : manifest.model,
      backend: manifest.backend,
      tools: manifest.tools,
      mcp,
      skills,
      persona: bundle.persona,
      slug: this.#freeSlug(bundle.slug),
      warnings,
    };
  }

  /** Create the crew member, pending review; its skills wait as pending skills. */
  async import(user: UserRow, input: { bundle: unknown; slug: string }): Promise<CrewDetailDto> {
    const { bundle, manifest } = this.#clean(input.bundle);
    const slug = CrewSlug.parse(input.slug);
    if (this.deps.crew.registry.has(slug)) {
      throw new HttpError(409, `a crew member called "${slug}" already exists; pick another slug`);
    }
    const available = await this.deps.providers.available();
    const usable =
      manifest.model === DEFAULT_MODEL ||
      available.some((m) => `${m.provider}/${m.id}` === manifest.model);
    const { defaultModel } = await this.deps.settings.get();
    const created = await this.deps.crew.create({
      slug,
      manifest: { ...manifest, model: usable ? manifest.model : defaultModel },
      persona: bundle.persona,
      createdById: user.id,
      status: "pending_review",
    });
    for (const s of bundle.skills) {
      this.deps.skills.createByCrew(slug, user.id, "crew", s.content, false);
    }
    return created;
  }

  /** Validate a bundle and reduce its manifest to the shareable fields. */
  #clean(json: unknown): { bundle: CrewBundle; manifest: CrewManifest } {
    const parsed = CrewBundleSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      throw new HttpError(400, `not a valid Shipmate crew file: ${where}${issue?.message ?? ""}`);
    }
    const b = parsed.data;
    let manifest: CrewManifest;
    try {
      manifest = parseManifestYaml(b.manifest);
      // Only the fields a shared crew member may carry; this instance decides the rest.
      manifest = parseManifestYaml(stringifyYaml(shareableManifest(manifest)));
    } catch (err) {
      if (err instanceof CrewValidationError) throw new HttpError(400, err.message);
      throw err;
    }
    const seen = new Set<string>();
    for (const s of b.skills) {
      let name: string;
      try {
        name = parseSkill(s.content).name;
      } catch (err) {
        if (err instanceof SkillError) throw new HttpError(400, `skill ${s.name}: ${err.message}`);
        throw err;
      }
      if (name !== s.name)
        throw new HttpError(400, `skill ${s.name}: its frontmatter says ${name}`);
      if (seen.has(name)) throw new HttpError(400, `skill ${name} appears twice`);
      seen.add(name);
    }
    const bundle: CrewBundle = {
      format: "shipmate-crew",
      version: 1,
      slug: b.slug,
      manifest: stringifyYaml(shareableManifest(manifest)),
      persona: b.persona,
      skills: b.skills,
      ...(b.exportedAt ? { exportedAt: b.exportedAt } : {}),
    };
    return { bundle, manifest };
  }

  #freeSlug(wanted: string): string {
    if (!this.deps.crew.registry.has(wanted)) return wanted;
    for (let i = 2; i < 100; i++) {
      const candidate = `${wanted.slice(0, 36)}-${i}`;
      if (!this.deps.crew.registry.has(candidate)) return candidate;
    }
    return `${wanted.slice(0, 30)}-${Date.now().toString(36).slice(-6)}`;
  }
}

// ---------- fetching a bundle from a URL ----------

type Lookup = (host: string) => Promise<Array<{ address: string }>>;
type FetchLike = (
  url: string,
  init: {
    redirect: "manual";
    signal: AbortSignal;
    headers: Record<string, string>;
    /** The checked addresses of the URL's host; the request must connect to one of these. */
    addresses: Array<{ address: string }>;
  },
) => Promise<Response>;

/** Loopback, private, link-local, CGNAT and other addresses a server should not be sent to. */
export function isPublicAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    // Unspecified, loopback, IPv4-compatible and other IPv4-embedding forms (::a.b.c.d,
    // ::ffff:7f00:1), and NAT64, which reaches IPv4 addresses through a gateway.
    if (ip.startsWith("::") || ip.startsWith("64:ff9b:")) return false;
    if (/^f[cd]/.test(ip)) return false; // unique local
    if (/^fe[89a-f]/.test(ip)) return false; // link-local and (deprecated) site-local
    if (ip.startsWith("ff")) return false; // multicast
    return true;
  }
  return false;
}

/**
 * Download a crew file over https from a public host: no redirects to http or private
 * addresses, 10 seconds, 512 KB at most.
 */
export async function fetchBundleText(
  url: string,
  options: { fetch?: FetchLike; lookup?: Lookup } = {},
): Promise<string> {
  const doFetch = options.fetch ?? pinnedFetch;
  const lookup =
    options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const signal = AbortSignal.timeout(10_000);
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new HttpError(400, "that is not a valid URL");
    }
    if (u.protocol !== "https:") throw new HttpError(400, "only https:// links can be imported");
    if (u.username || u.password) throw new HttpError(400, "links with a login cannot be imported");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host).catch(() => {
          throw new HttpError(400, `cannot find ${host}`);
        });
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
      throw new HttpError(400, "that link points at a private or local address");
    }
    let res: Response;
    try {
      res = await doFetch(u.toString(), {
        redirect: "manual",
        signal,
        headers: { accept: "application/json, text/plain" },
        addresses,
      });
    } catch (err) {
      throw new HttpError(400, `could not download it (${(err as Error).message})`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const next = res.headers.get("location");
      if (!next) throw new HttpError(400, "the link redirects nowhere");
      current = new URL(next, u).toString();
      continue;
    }
    if (!res.ok) throw new HttpError(400, `the link answered ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BUNDLE_BYTES)
      throw new HttpError(400, "that file is too large (512 KB at most)");
    return readLimited(res, MAX_BUNDLE_BYTES);
  }
  throw new HttpError(400, "too many redirects");
}

/**
 * A lookup that answers with the addresses already checked, instead of asking DNS again. Node's
 * own fetch resolves the name a second time when it connects, so a name that answers a public
 * address for the check and a private one for the connection (DNS rebinding) would get through.
 */
export function pinnedLookup(addresses: Array<{ address: string }>): LookupFunction {
  const all = addresses.map((a) => ({ address: a.address, family: isIP(a.address) || 4 }));
  return (_host, options, callback) => {
    const first = all[0];
    if (!first) callback(new Error("no checked address"), "", 4);
    else if (options.all) callback(null, all);
    else callback(null, first.address, first.family);
  };
}

/** GET over https that connects only to the checked addresses, with TLS for the real host name. */
function pinnedFetch(url: string, init: Parameters<FetchLike>[1]): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      { headers: init.headers, signal: init.signal, lookup: pinnedLookup(init.addresses) },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`unexpected status ${status}`));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            headers.append(name, v);
          }
        }
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        resolve(
          new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(400, "that file is too large (512 KB at most)");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
