import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { WebSearchSettingsDto, WebSearchSource } from "@shipmate/core";
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
  /**
   * Loads a page from one of `addresses`, the ones that were checked, and nowhere else. Defaults
   * to `pinnedFetch`; when only `fetch` is given (tests), pages go through that instead.
   */
  fetchPage?: PageFetch;
}

export type PageFetch = (
  url: URL,
  addresses: string[],
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/**
 * GET a page, connecting only to the given addresses. The host name was looked up and checked
 * once; a second lookup at connect time could answer differently (a name that first points at
 * the public web and then at the home network), so the connection never asks again. The name
 * is still what the server sees and what its certificate is checked against.
 */
export const pinnedFetch: PageFetch = (url, addresses, init) =>
  new Promise((resolve, reject) => {
    const pinned = addresses.map((address) => ({ address, family: isIP(address) }));
    const lookup: LookupFunction = (_host, options, done) => {
      const first = pinned[0];
      if (!first) done(new Error("no address"), "", 0);
      else if (options.all) done(null, pinned);
      else done(null, first.address, first.family);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        headers: { ...init.headers, "accept-encoding": "identity" },
        lookup,
        agent: false,
        signal: init.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`unexpected status ${status}`));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

const DEFAULTS: WebSearchSettingsDto = { source: "duckduckgo", searxngUrl: "", readPages: true };
const SOURCES: WebSearchSource[] = ["duckduckgo", "searxng", "off"];
const DUCKDUCKGO = "https://html.duckduckgo.com/html/";
/** DuckDuckGo turns away clients that do not look like a browser. */
const BROWSER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : +code.slice(1);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Parts of a page that are never its text. */
const SKIPPED =
  /<!--|<(script|style|noscript|svg|template|iframe|nav|footer|header|form|aside)(?=[\s>])/g;

/**
 * `html` without comments and the SKIPPED blocks. One pass: a page is at most a couple of
 * megabytes of anything at all, and a pattern that looks ahead for each opening tag takes time
 * that grows with the square of that, with the whole server waiting on it.
 */
function dropSkipped(html: string): string {
  const lower = html.toLowerCase();
  const unclosed = new Set<string>();
  let out = "";
  let at = 0;
  for (const m of lower.matchAll(SKIPPED)) {
    if (m.index < at) continue;
    const close = m[1] ? `</${m[1]}>` : "-->";
    if (unclosed.has(close)) continue;
    const end = lower.indexOf(close, m.index);
    if (end < 0) {
      // Never closed: nothing later closes either, so this kind is left for the tag stripping.
      unclosed.add(close);
      continue;
    }
    out += `${html.slice(at, m.index)} `;
    at = end + close.length;
  }
  return out + html.slice(at);
}

/** From the first `<tag>` to the last `</tag>`, or null when the page has no such part. */
function section(html: string, lower: string, tag: string): string | null {
  const open = new RegExp(`<${tag}[\\s>]`).exec(lower);
  if (!open) return null;
  const close = lower.lastIndexOf(`</${tag}>`);
  return close > open.index ? html.slice(open.index, close) : null;
}

/** A web page as plain text: its title, then its readable text with scripts and menus dropped. */
export function htmlToText(html: string): { title: string; text: string } {
  const lower = html.toLowerCase();
  const titleOpen = /<title(?:\s[^<>]{0,500})?>/.exec(lower);
  const titleStart = titleOpen ? titleOpen.index + titleOpen[0].length : -1;
  const titleEnd = titleStart < 0 ? -1 : lower.indexOf("</title>", titleStart);
  const title = decodeEntities(titleEnd < 0 ? "" : html.slice(titleStart, titleEnd).slice(0, 500))
    .replace(/\s+/g, " ")
    .trim();
  // Prefer the article or main part when the page marks one.
  const main =
    section(html, lower, "article") ??
    section(html, lower, "main") ??
    section(html, lower, "body") ??
    html;
  const text = decodeEntities(
    dropSkipped(main)
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|ul|ol|tr|table|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<li(?=[\s>])/gi, "\n- <li")
      // Stops at the next "<" too, so a page of stray "<" is still read in one pass.
      .replace(/<[^<>]+>/g, " "),
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
  readonly #fetchPage: PageFetch;
  readonly #lookup: (host: string) => Promise<string[]>;

  constructor(
    private readonly settings: SettingsService,
    deps: WebDeps = {},
  ) {
    this.#fetch = deps.fetch ?? fetch;
    const plain = deps.fetch;
    this.#fetchPage =
      deps.fetchPage ??
      (plain
        ? (url, _addresses, init) => plain(url, { redirect: "manual", ...init })
        : pinnedFetch);
    this.#lookup =
      deps.lookup ?? (async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address));
  }

  /** The settings as last read, for places that cannot wait (which tools a session gets). */
  snapshot: WebSearchSettingsDto = DEFAULTS;

  async getSettings(): Promise<WebSearchSettingsDto> {
    const saved = await this.settings.getJson<Partial<WebSearchSettingsDto>>(KEY);
    this.snapshot = {
      source: SOURCES.includes(saved?.source as WebSearchSource)
        ? (saved?.source as WebSearchSource)
        : DEFAULTS.source,
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
    if (next.source === "searxng" && !next.searxngUrl) {
      throw new HttpError(400, "Enter your SearXNG address first.");
    }
    await this.settings.setJson(KEY, next);
    this.snapshot = next;
    return next;
  }

  /** Search with the chosen source. Throws a plain sentence when it cannot. */
  async search(
    query: string,
    limit = 6,
    using?: { source: WebSearchSource; searxngUrl: string },
  ): Promise<WebResult[]> {
    const { source, searxngUrl } = using ?? (await this.getSettings());
    if (source === "off") throw new Error("Web search is turned off under Settings, General.");
    if (source === "duckduckgo") return this.#duckDuckGo(query, limit);
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

  /** Search DuckDuckGo's plain web page. It is not an official API and can be limited. */
  async #duckDuckGo(query: string, limit: number): Promise<WebResult[]> {
    let res: Response;
    try {
      res = await this.#fetch(`${DUCKDUCKGO}?q=${encodeURIComponent(query)}`, {
        headers: { accept: "text/html", "user-agent": BROWSER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error("Could not reach DuckDuckGo.");
    }
    const html = res.ok ? await readCapped(res, MAX_PAGE_BYTES) : "";
    const results = parseDuckDuckGo(html).slice(0, limit);
    if (results.length) return results;
    if (res.status !== 200 || /anomaly|challenge-form|captcha/i.test(html)) {
      throw new Error(
        "DuckDuckGo is limiting searches from this server right now. Try again later, or an admin can switch to a SearXNG address under Settings, General.",
      );
    }
    return [];
  }

  /** Whether a source answers a search, for the Test button. Nothing is saved. */
  async test(
    source: WebSearchSource,
    searxngUrl: string,
  ): Promise<{ ok: boolean; message: string }> {
    const address = searxngUrl.trim().replace(/\/+$/, "");
    if (source === "off") return { ok: false, message: "Search is turned off." };
    if (source === "searxng" && !/^https?:\/\/\S+$/i.test(address)) {
      return { ok: false, message: "The address must start with http:// or https://" };
    }
    try {
      const results = await this.search("weather", 6, { source, searxngUrl: address });
      return results.length
        ? { ok: true, message: `It works: ${results.length} results came back.` }
        : { ok: false, message: "It answered, but with no results." };
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
    let { url, addresses } = await this.#publicUrl(address);
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        res = await this.#fetchPage(url, addresses, {
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
      ({ url, addresses } = await this.#publicUrl(new URL(next, url).toString()));
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

  /**
   * The address as a URL, with the addresses its host resolves to. Refused unless every one of
   * them is public; the page is then loaded from those addresses only.
   */
  async #publicUrl(address: string): Promise<{ url: URL; addresses: string[] }> {
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
    return { url, addresses };
  }
}

/** The results on DuckDuckGo's plain results page; ads and its own links are left out. */
export function parseDuckDuckGo(html: string): WebResult[] {
  const out: WebResult[] = [];
  const plain = (s: string) =>
    decodeEntities(s.replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
  const links = [
    ...html.matchAll(/<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi),
  ];
  links.forEach((m, i) => {
    const href = decodeEntities(m[1]?.match(/\bhref="([^"]*)"/i)?.[1] ?? "");
    let url = href.startsWith("//") ? `https:${href}` : href;
    try {
      const parsed = new URL(url);
      // Results go through a redirect that carries the real address in `uddg`.
      if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) {
        url = parsed.searchParams.get("uddg") ?? "";
      }
      if (!/^https?:\/\//i.test(url) || /(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname)) {
        return;
      }
    } catch {
      return;
    }
    // The summary sits between this result's link and the next one.
    const from = (m.index ?? 0) + m[0].length;
    const to = links[i + 1]?.index ?? html.length;
    const snippet = html
      .slice(from, to)
      .match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i)?.[1];
    out.push({
      title: plain(m[2] ?? "").slice(0, 200) || url,
      url,
      snippet: plain(snippet ?? "").slice(0, 400),
    });
  });
  return out;
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
