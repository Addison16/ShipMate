import type {
  CreateProjectRequest,
  ProjectDto,
  ProjectProvider,
  PullRequestDto,
  ShipyardFlow,
  ShipyardJobDto,
  ShipyardJobStatus,
  UpdateProjectRequest,
} from "@shipmate/core";
import { request } from "../api.js";

export type Tone = "neutral" | "accent" | "warn" | "danger" | "ok";

export const FLOW_LABELS: Record<ShipyardFlow, string> = {
  plan: "Plan a feature",
  fix_issue: "Fix issue",
  review_pr: "Review PR",
  triage: "Triage open issues",
  keep_ci_green: "Keep CI green",
};

export function flowLabel(flow: string): string {
  return (FLOW_LABELS as Record<string, string>)[flow] ?? flow.replace(/_/g, " ");
}

/** Badge for a PR's combined CI state. */
export function checksBadge(checks: PullRequestDto["checks"]): { tone: Tone; label: string } {
  switch (checks) {
    case "success":
      return { tone: "ok", label: "checks passing" };
    case "failure":
      return { tone: "danger", label: "checks failing" };
    case "pending":
      return { tone: "warn", label: "checks running" };
    default:
      return { tone: "neutral", label: "no checks" };
  }
}

export function prStateBadge(pr: Pick<PullRequestDto, "state" | "draft">): {
  tone: Tone;
  label: string;
} {
  if (pr.state === "merged") return { tone: "accent", label: "merged" };
  if (pr.state === "closed") return { tone: "neutral", label: "closed" };
  if (pr.draft) return { tone: "neutral", label: "draft" };
  return { tone: "ok", label: "open" };
}

export function sandboxBadge(status: ProjectDto["sandbox"]["status"]): {
  tone: Tone;
  label: string;
} {
  switch (status) {
    case "running":
      return { tone: "ok", label: "sandbox running" };
    case "stopped":
      return { tone: "neutral", label: "sandbox stopped" };
    case "unavailable":
      return { tone: "warn", label: "sandbox unavailable" };
    default:
      return { tone: "neutral", label: "no sandbox" };
  }
}

/** "Cloned · main · uncommitted changes", "Not cloned yet". */
export function workspaceSummary(ws: ProjectDto["workspace"]): string {
  if (!ws.cloned) return "Not cloned yet";
  const parts = ["Cloned"];
  if (ws.branch) parts.push(ws.branch);
  if (ws.dirty === true) parts.push("uncommitted changes");
  else if (ws.dirty === false) parts.push("clean");
  return parts.join(" · ");
}

export function repoUrl(repo: string | null): string | null {
  return repo ? `https://github.com/${repo}` : null;
}

export const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Accepts "owner/name", a github.com URL, or "owner/name.git"; returns "owner/name" or null. */
export function normalizeRepo(input: string): string | null {
  let t = input.trim();
  t = t.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  t = t.replace(/^git@github\.com:/i, "");
  t = t.replace(/\.git$/i, "").replace(/\/+$/, "");
  return REPO_PATTERN.test(t) ? t : null;
}

export interface ProjectForm {
  name: string;
  provider: ProjectProvider;
  repo: string;
  token: string;
  crewSlug: string;
  defaultBranch: string;
  sandboxImage: string;
}

export function emptyProjectForm(crewSlug = "shipwright"): ProjectForm {
  return {
    name: "",
    provider: "github",
    repo: "",
    token: "",
    crewSlug,
    defaultBranch: "",
    sandboxImage: "",
  };
}

export type ProjectFormResult =
  | { ok: true; request: CreateProjectRequest }
  | { ok: false; errors: Partial<Record<keyof ProjectForm, string>> };

/** Validate the new-project form and build the request; blanks are left out. */
export function validateProjectForm(form: ProjectForm): ProjectFormResult {
  const errors: Partial<Record<keyof ProjectForm, string>> = {};
  const name = form.name.trim();
  if (!name) errors.name = "Give the project a name.";
  let repo: string | null = null;
  if (form.provider === "github") {
    repo = normalizeRepo(form.repo);
    if (!form.repo.trim()) errors.repo = "Enter the repository as owner/name.";
    else if (!repo) errors.repo = 'Use the form "owner/name", e.g. octocat/hello-world.';
  }
  const branch = form.defaultBranch.trim();
  if (branch && /\s/.test(branch)) errors.defaultBranch = "Branch names cannot contain spaces.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const request: CreateProjectRequest = { name, provider: form.provider };
  if (repo) request.repo = repo;
  const token = form.token.trim();
  if (form.provider === "github" && token) request.token = token;
  if (form.crewSlug) request.crewSlug = form.crewSlug;
  if (branch) request.defaultBranch = branch;
  const image = form.sandboxImage.trim();
  if (image) request.sandboxImage = image;
  return { ok: true, request };
}

/** Only the fields that changed, for PATCH. Token handling is separate (replace or clear). */
export function projectChanges(
  project: ProjectDto,
  next: { name: string; crewSlug: string; defaultBranch: string; sandboxImage: string },
): UpdateProjectRequest {
  const out: UpdateProjectRequest = {};
  const name = next.name.trim();
  if (name && name !== project.name) out.name = name;
  if (next.crewSlug && next.crewSlug !== project.crewSlug) out.crewSlug = next.crewSlug;
  const branch = next.defaultBranch.trim();
  if (branch && branch !== project.defaultBranch) out.defaultBranch = branch;
  const image = next.sandboxImage.trim();
  if (image && image !== project.sandbox.image) out.sandboxImage = image;
  return out;
}

/** Badge text for where a conversation lives; null for the web (the default). */
export function surfaceLabel(surface: string): string | null {
  if (surface === "discord") return "Discord";
  if (surface === "watch") return "Watch";
  if (surface === "telegram") return "Telegram";
  if (surface === "slack") return "Slack";
  return null;
}

// ---------- issue-to-PR jobs ----------

const enc = encodeURIComponent;

export const jobsApi = {
  list: (projectId: string) =>
    request<{ jobs: ShipyardJobDto[] }>("GET", `/api/shipyard/projects/${enc(projectId)}/jobs`),
  assign: (projectId: string, issue: number) =>
    request<{ job: ShipyardJobDto }>("POST", `/api/shipyard/projects/${enc(projectId)}/jobs`, {
      issue,
    }),
  cancel: (id: string) =>
    request<{ job: ShipyardJobDto }>("POST", `/api/shipyard/jobs/${enc(id)}/cancel`),
  retry: (id: string) =>
    request<{ job: ShipyardJobDto }>("POST", `/api/shipyard/jobs/${enc(id)}/retry`),
  rotateWebhookSecret: (projectId: string) =>
    request<{ project: ProjectDto }>(
      "POST",
      `/api/shipyard/projects/${enc(projectId)}/webhook-secret`,
    ),
};

const ACTIVE: ShipyardJobStatus[] = [
  "working",
  "pr_open",
  "ci_running",
  "ci_failed",
  "reviewing",
  "addressing_review",
  "needs_input",
  "ready",
];

/** Still holds its issue (one active job per issue). */
export function isActiveJob(job: Pick<ShipyardJobDto, "status">): boolean {
  return ACTIVE.includes(job.status);
}

/** The status card's badge: "CI red (attempt 2 of 3)", "Ready for review", ... */
export function jobBadge(
  job: Pick<ShipyardJobDto, "status" | "attempts" | "maxAttempts">,
  reviewerName = "the reviewer",
): { tone: Tone; label: string } {
  switch (job.status) {
    case "working":
      return { tone: "accent", label: "Working" };
    case "pr_open":
      return { tone: "accent", label: "PR open" };
    case "ci_running":
      return {
        tone: "warn",
        label: job.attempts ? `CI running (after fix ${job.attempts})` : "CI running",
      };
    case "ci_failed":
      return { tone: "danger", label: `CI red (attempt ${job.attempts} of ${job.maxAttempts})` };
    case "reviewing":
      return { tone: "accent", label: `Review by ${reviewerName}` };
    case "addressing_review":
      return { tone: "accent", label: "Addressing review" };
    case "needs_input":
      return { tone: "warn", label: "Needs you" };
    case "ready":
      return { tone: "ok", label: "Ready for review" };
    case "gave_up":
      return { tone: "danger", label: "Gave up" };
    case "merged":
      return { tone: "ok", label: "Merged" };
    case "closed":
      return { tone: "neutral", label: "Closed" };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled" };
    default:
      return { tone: "neutral", label: String(job.status).replace(/_/g, " ") };
  }
}

/** Which buttons a job card shows for this viewer. */
export function jobActions(
  job: Pick<ShipyardJobDto, "status" | "user" | "pr">,
  viewer: { id: string; role: string },
): { cancel: boolean; retry: boolean } {
  const mine = job.user.id === viewer.id || viewer.role === "owner" || viewer.role === "admin";
  if (!mine) return { cancel: false, retry: false };
  return {
    cancel: isActiveJob(job) && job.status !== "ready",
    retry:
      job.status === "gave_up" ||
      job.status === "needs_input" ||
      (job.status === "cancelled" && job.pr !== null),
  };
}

/** Active jobs first (newest first), then up to `finished` finished ones. */
export function jobsForBoard(jobs: ShipyardJobDto[], finished = 6): ShipyardJobDto[] {
  const byNew = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...byNew.filter(isActiveJob), ...byNew.filter((j) => !isActiveJob(j)).slice(0, finished)];
}

/** The active job for each issue number, for the Issues tab. */
export function activeJobsByIssue(jobs: ShipyardJobDto[]): Map<number, ShipyardJobDto> {
  return new Map(jobs.filter(isActiveJob).map((j) => [j.issue.number, j]));
}

export interface JobSettingsForm {
  reviewerSlug: string;
  maxFixAttempts: string;
  triggerLabel: string;
  triggerAssignee: string;
}

export function jobSettingsForm(p: ProjectDto): JobSettingsForm {
  return {
    reviewerSlug: p.reviewerSlug ?? "",
    maxFixAttempts: String(p.maxFixAttempts),
    triggerLabel: p.triggerLabel ?? "",
    triggerAssignee: p.triggerAssignee ?? "",
  };
}

/** The PATCH for the job settings card: only what changed; an error string when invalid. */
export function jobSettingsChanges(
  p: ProjectDto,
  f: JobSettingsForm,
): UpdateProjectRequest | string {
  const out: UpdateProjectRequest = {};
  const reviewer = f.reviewerSlug || null;
  if (reviewer !== p.reviewerSlug) out.reviewerSlug = reviewer;
  const n = Number(f.maxFixAttempts);
  if (!/^\d+$/.test(f.maxFixAttempts.trim()) || n > 10) {
    return "Fix attempts: a whole number from 0 to 10.";
  }
  if (n !== p.maxFixAttempts) out.maxFixAttempts = n;
  const label = f.triggerLabel.trim();
  if (label !== (p.triggerLabel ?? "")) out.triggerLabel = label;
  const assignee = f.triggerAssignee.trim().replace(/^@/, "");
  if (assignee !== (p.triggerAssignee ?? "")) out.triggerAssignee = assignee;
  return out;
}
