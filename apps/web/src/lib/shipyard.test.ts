import type { ProjectDto, ShipyardJobDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  activeJobsByIssue,
  checksBadge,
  emptyProjectForm,
  flowLabel,
  jobActions,
  jobBadge,
  jobSettingsChanges,
  jobSettingsForm,
  jobsForBoard,
  normalizeRepo,
  projectChanges,
  prStateBadge,
  repoUrl,
  sandboxBadge,
  surfaceLabel,
  validateProjectForm,
  workspaceSummary,
} from "./shipyard.js";

function project(over: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: "p1",
    slug: "site",
    name: "Site",
    provider: "github",
    repo: "octo/site",
    defaultBranch: "main",
    crewSlug: "shipwright",
    hasToken: true,
    workspace: { cloned: true, branch: "main", dirty: false },
    sandbox: { status: "stopped", image: "node:22" },
    webhookUrl: null,
    webhookSecret: null,
    webhookLastDeliveryAt: null,
    reviewerSlug: null,
    triggerLabel: null,
    triggerAssignee: null,
    triggerUser: null,
    maxFixAttempts: 3,
    createdBy: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    ...over,
  };
}

describe("labels", () => {
  it("names flows and falls back for unknown ones", () => {
    expect(flowLabel("review_pr")).toBe("Review PR");
    expect(flowLabel("triage")).toBe("Triage open issues");
    expect(flowLabel("ship_it_now")).toBe("ship it now");
  });

  it("maps checks to badges", () => {
    expect(checksBadge("success")).toEqual({ tone: "ok", label: "checks passing" });
    expect(checksBadge("failure").tone).toBe("danger");
    expect(checksBadge("pending").tone).toBe("warn");
    expect(checksBadge(null).label).toBe("no checks");
  });

  it("maps PR state, with drafts", () => {
    expect(prStateBadge({ state: "open", draft: true }).label).toBe("draft");
    expect(prStateBadge({ state: "open", draft: false }).label).toBe("open");
    expect(prStateBadge({ state: "merged", draft: false }).label).toBe("merged");
    expect(prStateBadge({ state: "closed", draft: true }).label).toBe("closed");
  });

  it("describes sandbox and workspace", () => {
    expect(sandboxBadge("running").tone).toBe("ok");
    expect(sandboxBadge("none").label).toBe("no sandbox");
    expect(workspaceSummary({ cloned: false, branch: null, dirty: null })).toBe("Not cloned yet");
    expect(workspaceSummary({ cloned: true, branch: "feat/x", dirty: true })).toBe(
      "Cloned · feat/x · uncommitted changes",
    );
    expect(workspaceSummary({ cloned: true, branch: null, dirty: null })).toBe("Cloned");
  });

  it("builds repo links and surface labels", () => {
    expect(repoUrl("octo/site")).toBe("https://github.com/octo/site");
    expect(repoUrl(null)).toBeNull();
    expect(surfaceLabel("discord")).toBe("Discord");
    expect(surfaceLabel("watch")).toBe("Watch");
    expect(surfaceLabel("telegram")).toBe("Telegram");
    expect(surfaceLabel("slack")).toBe("Slack");
    expect(surfaceLabel("web")).toBeNull();
  });
});

describe("normalizeRepo", () => {
  it("accepts owner/name and common URL forms", () => {
    expect(normalizeRepo("octo/site")).toBe("octo/site");
    expect(normalizeRepo(" https://github.com/octo/site.git ")).toBe("octo/site");
    expect(normalizeRepo("git@github.com:octo/my.repo.git")).toBe("octo/my.repo");
  });

  it("rejects anything else", () => {
    expect(normalizeRepo("site")).toBeNull();
    expect(normalizeRepo("octo/site/tree/main")).toBeNull();
    expect(normalizeRepo("-octo/site")).toBeNull();
    expect(normalizeRepo("")).toBeNull();
  });
});

describe("validateProjectForm", () => {
  it("requires a name and an owner/name repo for GitHub", () => {
    const r = validateProjectForm({ ...emptyProjectForm(), repo: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.name).toBeDefined();
      expect(r.errors.repo).toMatch(/owner\/name/);
    }
  });

  it("builds a GitHub request, leaving blanks out", () => {
    const r = validateProjectForm({
      ...emptyProjectForm(),
      name: " Site ",
      repo: "https://github.com/octo/site",
      token: " github_pat_x ",
    });
    expect(r).toEqual({
      ok: true,
      request: {
        name: "Site",
        provider: "github",
        repo: "octo/site",
        token: "github_pat_x",
        crewSlug: "shipwright",
      },
    });
  });

  it("ignores repo and token for a local folder", () => {
    const r = validateProjectForm({
      ...emptyProjectForm("galley"),
      name: "Notes",
      provider: "local",
      repo: "garbage",
      token: "x",
      defaultBranch: "main",
      sandboxImage: "python:3.13",
    });
    expect(r).toEqual({
      ok: true,
      request: {
        name: "Notes",
        provider: "local",
        crewSlug: "galley",
        defaultBranch: "main",
        sandboxImage: "python:3.13",
      },
    });
  });

  it("rejects branch names with spaces", () => {
    const r = validateProjectForm({
      ...emptyProjectForm(),
      name: "a",
      repo: "o/r",
      defaultBranch: "my branch",
    });
    expect(r.ok).toBe(false);
  });
});

describe("projectChanges", () => {
  it("returns only changed fields", () => {
    const p = project();
    expect(
      projectChanges(p, {
        name: "Site",
        crewSlug: "shipwright",
        defaultBranch: "main",
        sandboxImage: "",
      }),
    ).toEqual({});
    expect(
      projectChanges(p, {
        name: "Website",
        crewSlug: "reviewer",
        defaultBranch: "develop",
        sandboxImage: "node:24",
      }),
    ).toEqual({
      name: "Website",
      crewSlug: "reviewer",
      defaultBranch: "develop",
      sandboxImage: "node:24",
    });
  });
});

describe("issue-to-PR jobs", () => {
  const job = (over: Partial<ShipyardJobDto> = {}): ShipyardJobDto => ({
    id: "j1",
    projectId: "p1",
    issue: { number: 12, title: "It breaks", url: null },
    status: "working",
    source: "manual",
    crewSlug: "shipwright",
    branch: null,
    pr: null,
    attempts: 0,
    maxAttempts: 3,
    reviewRounds: 0,
    reviewVerdict: null,
    detail: null,
    user: { id: "u1", name: "Addison" },
    conversationId: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...over,
  });

  it("labels each status the way the owner described them", () => {
    expect(jobBadge(job({ status: "ci_failed", attempts: 2 }))).toEqual({
      tone: "danger",
      label: "CI red (attempt 2 of 3)",
    });
    expect(jobBadge(job({ status: "ready" })).label).toBe("Ready for review");
    expect(jobBadge(job({ status: "gave_up" })).label).toBe("Gave up");
    expect(jobBadge(job({ status: "reviewing" }), "Bosun").label).toBe("Review by Bosun");
    expect(jobBadge(job({ status: "pr_open" })).label).toBe("PR open");
  });

  it("offers cancel and retry to the job's person and admins only", () => {
    const me = { id: "u1", role: "member" };
    const other = { id: "u2", role: "member" };
    const admin = { id: "u3", role: "admin" };
    expect(jobActions(job(), me)).toEqual({ cancel: true, retry: false });
    expect(jobActions(job(), other)).toEqual({ cancel: false, retry: false });
    expect(jobActions(job({ status: "gave_up" }), admin)).toEqual({ cancel: false, retry: true });
    expect(jobActions(job({ status: "cancelled" }), me).retry).toBe(false);
    expect(jobActions(job({ status: "cancelled", pr: { number: 4, url: "u" } }), me).retry).toBe(
      true,
    );
    expect(jobActions(job({ status: "ready" }), me).cancel).toBe(false);
  });

  it("puts active jobs first and keeps a few finished ones", () => {
    const list = [
      job({ id: "old-done", status: "merged", createdAt: "2026-10-01T00:00:00Z" }),
      job({ id: "active", status: "ci_running", createdAt: "2026-10-02T00:00:00Z" }),
      job({ id: "new-done", status: "gave_up", createdAt: "2026-10-03T00:00:00Z" }),
    ];
    expect(jobsForBoard(list).map((j) => j.id)).toEqual(["active", "new-done", "old-done"]);
    expect(jobsForBoard(list, 1).map((j) => j.id)).toEqual(["active", "new-done"]);
    expect([...activeJobsByIssue(list).keys()]).toEqual([12]);
  });

  it("sends only changed job settings and checks the attempt limit", () => {
    const p = project();
    expect(jobSettingsChanges(p, jobSettingsForm(p))).toEqual({});
    expect(
      jobSettingsChanges(p, {
        reviewerSlug: "bosun",
        maxFixAttempts: "2",
        triggerLabel: " shipwright ",
        triggerAssignee: "@shipmate-bot",
      }),
    ).toEqual({
      reviewerSlug: "bosun",
      maxFixAttempts: 2,
      triggerLabel: "shipwright",
      triggerAssignee: "shipmate-bot",
    });
    expect(
      jobSettingsChanges(project({ reviewerSlug: "bosun" }), {
        ...jobSettingsForm(project({ reviewerSlug: "bosun" })),
        reviewerSlug: "",
      }),
    ).toEqual({ reviewerSlug: null });
    expect(typeof jobSettingsChanges(p, { ...jobSettingsForm(p), maxFixAttempts: "11" })).toBe(
      "string",
    );
    expect(typeof jobSettingsChanges(p, { ...jobSettingsForm(p), maxFixAttempts: "x" })).toBe(
      "string",
    );
  });
});
