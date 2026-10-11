import type { ProjectDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  checksBadge,
  emptyProjectForm,
  flowLabel,
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
