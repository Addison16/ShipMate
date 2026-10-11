import type { IssueDto, PullRequestDto } from "@shipmate/core";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type State = "open" | "closed" | "all";

interface RawPull {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  updated_at: string;
  body?: string | null;
  mergeable_state?: string;
}

export interface PullDetail {
  pull: PullRequestDto;
  body: string;
  base: string;
  /** Names of failing check runs and statuses on the head commit. */
  failingChecks: string[];
  diff: string;
  diffTruncated: boolean;
}

/** A small GitHub REST client for one repo, with the project's token (when it has one). */
export class GitHubClient {
  constructor(
    readonly repo: string,
    private readonly token: string | null,
    private readonly api: string = GITHUB_API,
  ) {}

  async defaultBranch(): Promise<string> {
    const r = (await this.#json("GET", `/repos/${this.repo}`)) as { default_branch: string };
    return r.default_branch;
  }

  async listPulls(state: State = "open"): Promise<PullRequestDto[]> {
    const raw = (await this.#json(
      "GET",
      `/repos/${this.repo}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`,
    )) as RawPull[];
    return Promise.all(
      raw.map(async (p) => ({
        ...toPull(p),
        checks: p.state === "open" ? await this.checkState(p.head.sha).catch(() => null) : null,
      })),
    );
  }

  /** Combined CI state of a commit from commit statuses and check runs; null when none. */
  async checkState(sha: string): Promise<PullRequestDto["checks"]> {
    const { failing, pending, total } = await this.#checks(sha);
    if (!total) return null;
    if (failing.length) return "failure";
    if (pending) return "pending";
    return "success";
  }

  async #checks(sha: string): Promise<{ failing: string[]; pending: number; total: number }> {
    const [status, runs] = await Promise.all([
      this.#json("GET", `/repos/${this.repo}/commits/${sha}/status`).catch(() => null) as Promise<{
        statuses?: Array<{ context: string; state: string }>;
      } | null>,
      this.#json("GET", `/repos/${this.repo}/commits/${sha}/check-runs?per_page=100`).catch(
        () => null,
      ) as Promise<{
        check_runs?: Array<{ name: string; status: string; conclusion: string | null }>;
      } | null>,
    ]);
    const failing: string[] = [];
    let pending = 0;
    let total = 0;
    for (const s of status?.statuses ?? []) {
      total++;
      if (s.state === "failure" || s.state === "error") failing.push(s.context);
      else if (s.state === "pending") pending++;
    }
    for (const r of runs?.check_runs ?? []) {
      total++;
      if (r.status !== "completed") pending++;
      else if (
        ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? "")
      )
        failing.push(r.name);
    }
    return { failing, pending, total };
  }

  async listIssues(state: State = "open"): Promise<IssueDto[]> {
    const raw = (await this.#json(
      "GET",
      `/repos/${this.repo}/issues?state=${state}&per_page=50&sort=updated&direction=desc`,
    )) as Array<{
      number: number;
      title: string;
      state: "open" | "closed";
      html_url: string;
      labels: Array<string | { name?: string }>;
      user: { login: string } | null;
      updated_at: string;
      pull_request?: unknown;
    }>;
    return raw
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.html_url,
        labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        author: i.user?.login ?? "ghost",
        updatedAt: i.updated_at,
      }));
  }

  async getIssue(number: number): Promise<{ issue: IssueDto; body: string; isPull: boolean }> {
    const i = (await this.#json("GET", `/repos/${this.repo}/issues/${number}`)) as {
      number: number;
      title: string;
      state: "open" | "closed";
      html_url: string;
      body: string | null;
      labels: Array<string | { name?: string }>;
      user: { login: string } | null;
      updated_at: string;
      pull_request?: unknown;
    };
    return {
      issue: {
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.html_url,
        labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        author: i.user?.login ?? "ghost",
        updatedAt: i.updated_at,
      },
      body: i.body ?? "",
      isPull: Boolean(i.pull_request),
    };
  }

  async createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ number: number; url: string }> {
    const p = (await this.#json("POST", `/repos/${this.repo}/pulls`, input)) as RawPull;
    return { number: p.number, url: p.html_url };
  }

  /** Comment on an issue or a pull request (PRs share the issue comment thread). */
  async comment(number: number, body: string): Promise<{ url: string }> {
    const c = (await this.#json("POST", `/repos/${this.repo}/issues/${number}/comments`, {
      body,
    })) as { html_url: string };
    return { url: c.html_url };
  }

  async getPull(number: number, maxDiff = 60_000): Promise<PullDetail> {
    const p = (await this.#json("GET", `/repos/${this.repo}/pulls/${number}`)) as RawPull;
    const diffRes = await this.#fetch("GET", `/repos/${this.repo}/pulls/${number}`, undefined, {
      Accept: "application/vnd.github.diff",
    });
    const diffText = await diffRes.text();
    const checks =
      p.state === "open"
        ? await this.#checks(p.head.sha).catch(() => ({ failing: [], pending: 0, total: 0 }))
        : { failing: [], pending: 0, total: 0 };
    const state: PullRequestDto["checks"] = !checks.total
      ? null
      : checks.failing.length
        ? "failure"
        : checks.pending
          ? "pending"
          : "success";
    return {
      pull: { ...toPull(p), checks: state },
      body: p.body ?? "",
      base: p.base.ref,
      failingChecks: checks.failing,
      diff: diffText.slice(0, maxDiff),
      diffTruncated: diffText.length > maxDiff,
    };
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(method, path, body);
    return res.json();
  }

  async #fetch(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Shipmate",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const j = (await res.json()) as { message?: string; errors?: Array<{ message?: string }> };
        message = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
      } catch {}
      throw new GitHubError(res.status, `GitHub ${res.status}: ${message || "request failed"}`);
    }
    return res;
  }
}

function toPull(p: RawPull): PullRequestDto {
  return {
    number: p.number,
    title: p.title,
    state: p.merged_at ? "merged" : p.state,
    draft: Boolean(p.draft),
    url: p.html_url,
    branch: p.head.ref,
    author: p.user?.login ?? "ghost",
    checks: null,
    updatedAt: p.updated_at,
  };
}
