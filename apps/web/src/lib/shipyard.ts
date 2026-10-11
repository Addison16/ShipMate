import type {
  CreateProjectRequest,
  ProjectDto,
  ProjectProvider,
  PullRequestDto,
  ShipyardFlow,
  UpdateProjectRequest,
} from "@shipmate/core";

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
