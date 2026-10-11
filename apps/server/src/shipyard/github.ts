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
  node_id?: string;
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
    readonly api: string = GITHUB_API,
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

  /** CI state of a commit plus the names of failing checks (for job prompts and cards). */
  async checkSummary(sha: string): Promise<{ state: PullRequestDto["checks"]; failing: string[] }> {
    const { failing, pending, total } = await this.#checks(sha);
    const state = !total ? null : failing.length ? "failure" : pending ? "pending" : "success";
    return { state, failing };
  }

  /** The bits of a pull request a job follows. */
  async pullState(number: number): Promise<{
    state: PullRequestDto["state"];
    draft: boolean;
    headSha: string;
    branch: string;
    url: string;
    nodeId: string | null;
  }> {
    const p = (await this.#json("GET", `/repos/${this.repo}/pulls/${number}`)) as RawPull;
    return {
      state: p.merged_at ? "merged" : p.state,
      draft: Boolean(p.draft),
      headSha: p.head.sha,
      branch: p.head.ref,
      url: p.html_url,
      nodeId: p.node_id ?? null,
    };
  }

  /**
   * Turn a draft into a pull request ready for review. REST cannot do this; it is a GraphQL
   * mutation (at /graphql, or /api/graphql on GitHub Enterprise).
   */
  async markReadyForReview(nodeId: string): Promise<void> {
    const url = this.api.endsWith("/api/v3")
      ? `${this.api.slice(0, -"/v3".length)}/graphql`
      : `${this.api}/graphql`;
    const res = await this.#fetch("POST", "", undefined, {}, url, {
      query:
        "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: nodeId },
    });
    const j = (await res.json()) as { errors?: Array<{ message?: string }> };
    if (j.errors?.length) {
      throw new GitHubError(422, `GitHub: ${j.errors.map((e) => e.message).join("; ")}`);
    }
  }

  /**
   * Post a review. `event` is COMMENT for Shipmate's own PRs (GitHub refuses approving or
   * requesting changes on a PR by the same account). Inline comments GitHub cannot place are
   * folded into the body instead of failing the review.
   */
  async createReview(
    number: number,
    input: {
      body: string;
      event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      commitId?: string | undefined;
      comments?: Array<{ path: string; line: number; body: string }>;
    },
  ): Promise<{ url: string }> {
    const base = {
      body: input.body,
      event: input.event,
      ...(input.commitId ? { commit_id: input.commitId } : {}),
    };
    const path = `/repos/${this.repo}/pulls/${number}/reviews`;
    const comments = input.comments ?? [];
    try {
      const r = (await this.#json("POST", path, {
        ...base,
        ...(comments.length
          ? {
              comments: comments.map((c) => ({
                path: c.path,
                line: c.line,
                side: "RIGHT",
                body: c.body,
              })),
            }
          : {}),
      })) as { html_url: string };
      return { url: r.html_url };
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 422 || !comments.length) throw err;
      const folded = `${input.body}\n\n${comments.map((c) => `- \`${c.path}:${c.line}\`: ${c.body}`).join("\n")}`;
      const r = (await this.#json("POST", path, { ...base, body: folded })) as { html_url: string };
      return { url: r.html_url };
    }
  }

  /** Open issues with a label or an assignee (automatic job triggers, when polling). */
  async issuesWith(filter: { label?: string; assignee?: string }): Promise<IssueDto[]> {
    const q = new URLSearchParams({ state: "open", per_page: "50" });
    if (filter.label) q.set("labels", filter.label);
    if (filter.assignee) q.set("assignee", filter.assignee);
    const raw = (await this.#json("GET", `/repos/${this.repo}/issues?${q}`)) as RawIssue[];
    return raw.filter((i) => !i.pull_request).map(toIssue);
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
    )) as RawIssue[];
    return raw.filter((i) => !i.pull_request).map(toIssue);
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
    url = `${this.api}${path}`,
    graphql?: unknown,
  ): Promise<Response> {
    const payload = graphql ?? body;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Shipmate",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
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

interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  labels: Array<string | { name?: string }>;
  user: { login: string } | null;
  updated_at: string;
  pull_request?: unknown;
}

function toIssue(i: RawIssue): IssueDto {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
    labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    author: i.user?.login ?? "ghost",
    updatedAt: i.updated_at,
  };
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
