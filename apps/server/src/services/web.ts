import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WebSearchSettingsDto } from "@shipmate/core";
import { HttpError } from "../auth.js";
import type { SettingsService } from "./settings.js";

const KEY = "webSearch";
const TIMEOUT_MS = 15_000;
/** Most bytes read from one page, and most characters of it handed to the model at once. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const PAGE_CHARS = 12_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Shipmate/1 (self-hosted assistant; fetches pages a person asked about)";

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebDeps {
  fetch?: typeof fetch;
  /** Every address a host name resolves to (injectable for tests). */
  lookup?: (host: string) => Promise<string[]>;
}

const DEFAULTS: WebSearchSettingsDto = { searxngUrl: "", readPages: true };

/** True for loopback, private, link-local and other addresses that are not the public web. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const a = address.toLowerCase();
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return (
      a === "::" ||
      a === "::1" ||
      a.startsWith("::ffff:") ||
      /^f[cd]/.test(a) ||
      /^fe[89ab]/.test(a) ||
      a.startsWith("ff") ||
      a.startsWith("64:ff9b:")
    );
  }
  return true;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : +code.slice(1);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** A web page as plain text: its title, then its readable text with scripts and menus dropped. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // Prefer the article or main part when the page marks one.
  const main =
    html.match(/<article[\s>][\s\S]*<\/article>/i)?.[0] ??
    html.match(/<main[\s>][\s\S]*<\/main>/i)?.[0] ??
    html.match(/<body[\s>][\s\S]*<\/body>/i)?.[0] ??
    html;
  const text = decodeEntities(
    main
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|template|iframe|nav|footer|header|form|aside)[\s>][\s\S]*?<\/\1>/gi,
        " ",
      )
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|ul|ol|tr|table|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<li(?=[\s>])/gi, "\n- <li")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/**
 * The web for crew members, built in: search through the household's own SearXNG, and read a
 * public page as text. Page reading refuses addresses on the home network, so a page cannot
 * talk a crew member into fetching the router or another service behind the firewall.
 */
export class WebService {
  readonly #fetch: typeof fetch;
  readonly #lookup: (host: string) => Promise<string[]>;

  constructor(
    private readonly settings: SettingsService,
    deps: WebDeps = {},
  ) {
    this.#fetch = deps.fetch ?? fetch;
    this.#lookup =
      deps.lookup ?? (async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address));
  }

  /** The settings as last read, for places that cannot wait (which tools a session gets). */
  snapshot: WebSearchSettingsDto = DEFAULTS;

  async getSettings(): Promise<WebSearchSettingsDto> {
    const saved = await this.settings.getJson<Partial<WebSearchSettingsDto>>(KEY);
    this.snapshot = {
      searxngUrl: typeof saved?.searxngUrl === "string" ? saved.searxngUrl : DEFAULTS.searxngUrl,
      readPages: typeof saved?.readPages === "boolean" ? saved.readPages : DEFAULTS.readPages,
    };
    return this.snapshot;
  }

  async updateSettings(patch: Partial<WebSearchSettingsDto>): Promise<WebSearchSettingsDto> {
    const next = { ...(await this.getSettings()), ...patch };
    next.searxngUrl = next.searxngUrl.trim().replace(/\/+$/, "");
    if (next.searxngUrl) {
      let url: URL;
      try {
        url = new URL(next.searxngUrl);
      } catch {
        throw new HttpError(
          400,
          "That is not a web address. It looks like http://192.168.1.10:8080",
        );
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new HttpError(400, "The address must start with http:// or https://");
      }
    }
    await this.settings.setJson(KEY, next);
    this.snapshot = next;
    return next;
  }

  /** Search through SearXNG's JSON API. Throws a plain sentence when it cannot. */
  async search(query: string, limit = 6, address?: string): Promise<WebResult[]> {
    const searxngUrl = address ?? (await this.getSettings()).searxngUrl;
    if (!searxngUrl) {
      throw new Error(
        "Web search is not set up. An admin can paste a SearXNG address under Settings, General.",
      );
    }
    const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error(`Could not reach SearXNG at ${searxngUrl}.`);
    }
    if (res.status === 403) {
      throw new Error(
        "SearXNG refused the search. Its settings.yml needs `json` under search → formats.",
      );
    }
    if (!res.ok) throw new Error(`SearXNG answered with an error (${res.status}).`);
    let data: { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new Error("SearXNG did not answer with JSON. Check the address.");
    }
    const out: WebResult[] = [];
    for (const r of data.results ?? []) {
      if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
      out.push({
        title: String(r.title ?? r.url).slice(0, 200),
        url: r.url,
        snippet: String(r.content ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 400),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Whether the address answers a search, for the Test button. Nothing is saved. */
  async test(searxngUrl: string): Promise<{ ok: boolean; message: string }> {
    const address = searxngUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/\S+$/i.test(address)) {
      return { ok: false, message: "The address must start with http:// or https://" };
    }
    try {
      const results = await this.search("weather", 6, address);
      return { ok: true, message: `It works: ${results.length} results came back.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * A public web page as text, `PAGE_CHARS` at a time from character `from`. Only http(s), only
   * public addresses (checked again after every redirect), only text.
   */
  async read(
    address: string,
    from = 0,
  ): Promise<{ url: string; title: string; text: string; from: number; total: number }> {
    if (!(await this.getSettings()).readPages) throw new Error("Reading web pages is turned off.");
    let url = await this.#publicUrl(address);
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        res = await this.#fetch(url, {
          redirect: "manual",
          headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new Error(`Could not load ${url.host}.`);
      }
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) break;
      await res.body?.cancel().catch(() => {});
      if (hop === MAX_REDIRECTS) throw new Error("That page redirects too many times.");
      url = await this.#publicUrl(new URL(next, url).toString());
    }
    if (!res) throw new Error("Could not load that page.");
    if (!res.ok) throw new Error(`${url.host} answered with an error (${res.status}).`);
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !/^(text\/|application\/(json|xml|xhtml\+xml))/.test(type)) {
      throw new Error(`That address is not a page of text (${type.split(";")[0]}).`);
    }
    const raw = await readCapped(res, MAX_PAGE_BYTES);
    const { title, text } =
      /html/.test(type) || /<html[\s>]/i.test(raw.slice(0, 2000))
        ? htmlToText(raw)
        : { title: "", text: raw.trim() };
    const start = Math.min(Math.max(0, Math.floor(from) || 0), text.length);
    return {
      url: url.toString(),
      title,
      text: text.slice(start, start + PAGE_CHARS),
      from: start,
      total: text.length,
    };
  }

  /** The address as a URL, refused unless every address its host resolves to is public. */
  async #publicUrl(address: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(address.trim());
    } catch {
      throw new Error("That is not a web address. Give the full address, starting with https://");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https addresses can be read.");
    }
    if (url.username || url.password) throw new Error("Addresses with a password cannot be read.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try {
        addresses = await this.#lookup(host);
      } catch {
        throw new Error(`Could not find ${host}.`);
      }
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw new Error(`${host} is on the home network or not a public address, so it is not read.`);
    }
    return url;
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks).subarray(0, max));
}
