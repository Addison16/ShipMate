import type { ReleaseCheckDto, ReleaseDto } from "@shipmate/core";

export const RELEASES_REPO = "Addison16/ShipMate";
/** A good answer is reused this long; GitHub allows 60 unauthenticated requests an hour. */
const FRESH_MS = 6 * 60 * 60_000;
/** After a failure, try again sooner. */
const RETRY_MS = 15 * 60_000;

/** "v1.2.3" or "1.2.3-rc.1" → [1, 2, 3] plus the pre-release part; null if not semver. */
export function parseVersion(v: string): { nums: [number, number, number]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
}

/** Positive when a is newer than b. A release outranks its own pre-releases. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

/**
 * The latest Shipmate release from GitHub, cached and failure-tolerant: a failed check is
 * reported on the Health page and never breaks it. Off entirely with SHIPMATE_UPDATE_CHECK=off.
 */
export class ReleaseChecker {
  #cache: { at: number; ok: boolean; latest: ReleaseDto | null; error: string | null } | null =
    null;
  #inflight: Promise<void> | null = null;

  constructor(
    private readonly options: {
      current: string;
      enabled: boolean;
      apiBase?: string | undefined;
      repo?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  async check(refresh = false): Promise<ReleaseCheckDto> {
    if (!this.options.enabled) {
      return { enabled: false, latest: null, updateAvailable: false, checkedAt: null, error: null };
    }
    const now = this.options.now?.() ?? Date.now();
    const c = this.#cache;
    const stale = !c || now - c.at > (c.ok ? FRESH_MS : RETRY_MS);
    if (refresh || stale) {
      this.#inflight ??= this.#fetch().finally(() => {
        this.#inflight = null;
      });
      await this.#inflight;
    }
    const cache = this.#cache;
    const latest = cache?.latest ?? null;
    return {
      enabled: true,
      latest,
      updateAvailable: latest ? compareVersions(latest.version, this.options.current) > 0 : false,
      checkedAt: cache ? new Date(cache.at).toISOString() : null,
      error: cache?.error ?? null,
    };
  }

  async #fetch(): Promise<void> {
    const base = (this.options.apiBase || "https://api.github.com").replace(/\/+$/, "");
    const repo = this.options.repo ?? RELEASES_REPO;
    const at = this.options.now?.() ?? Date.now();
    try {
      const res = await (this.options.fetchImpl ?? fetch)(`${base}/repos/${repo}/releases/latest`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `shipmate/${this.options.current}`,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) {
        this.#cache = { at, ok: true, latest: null, error: null };
        return;
      }
      if (!res.ok) {
        const limited = res.status === 403 || res.status === 429;
        throw new Error(
          limited
            ? "GitHub rate limit reached; trying again later"
            : `GitHub answered ${res.status}`,
        );
      }
      const body = (await res.json()) as {
        tag_name?: string;
        name?: string | null;
        html_url?: string;
        published_at?: string | null;
      };
      const version = (body.tag_name ?? "").replace(/^v/, "");
      if (!parseVersion(version)) throw new Error(`unexpected release tag "${body.tag_name}"`);
      this.#cache = {
        at,
        ok: true,
        latest: {
          version,
          name: body.name || `v${version}`,
          url: body.html_url ?? `https://github.com/${repo}/releases/tag/v${version}`,
          publishedAt: body.published_at ?? null,
        },
        error: null,
      };
    } catch (err) {
      const e = err as Error;
      // Keep the last good answer; just say the refresh failed.
      this.#cache = {
        at,
        ok: false,
        latest: this.#cache?.latest ?? null,
        error:
          e.name === "TimeoutError"
            ? "GitHub did not answer in time"
            : e.message === "fetch failed"
              ? "Could not reach GitHub (offline?)"
              : e.message,
      };
    }
  }
}
