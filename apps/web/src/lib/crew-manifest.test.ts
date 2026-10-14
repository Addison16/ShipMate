import { describe, expect, it } from "vitest";
import {
  applyManifestForm,
  cleanList,
  engineFor,
  hasToolGroup,
  otherCliTools,
  readManifestForm,
  setToolGroup,
  switchEngine,
} from "./crew-manifest.js";

const CAPTAIN = `# The coordinator
name: Captain
role: coordinator of the crew
model: anthropic/claude-sonnet-5-5
tools: [read, write, edit, bash, web_fetch]
mcp: [memory, time] # bundled
skills: []
approval: ask
visibility: shared
captain: true
`;

function form(yaml: string) {
  const r = readManifestForm(yaml);
  if (!r.ok) throw new Error(r.error);
  return r.form;
}

describe("readManifestForm", () => {
  it("fills in defaults", () => {
    const f = form("name: A\nrole: r\nmodel: faux/m\n");
    expect(f).toMatchObject({
      backend: "pi",
      cliPermissionMode: "dontAsk",
      tools: [],
      approval: "ask",
      neverFor: [],
      monthlyCapUsd: null,
      visibility: "shared",
      captain: false,
      avatar: "",
    });
  });

  it("reads never-for approvals and cli settings", () => {
    const f = form(
      "name: A\nrole: r\nmodel: faux/m\nbackend: claude-code-cli\ncli:\n  model: opus\n  allowedTools: [Read]\n  permissionMode: plan\napproval:\n  never-for: [bash]\n",
    );
    expect(f.approval).toBe("never-for");
    expect(f.neverFor).toEqual(["bash"]);
    expect(f.cliModel).toBe("opus");
    expect(f.cliAllowedTools).toEqual(["Read"]);
    expect(f.cliPermissionMode).toBe("plan");
  });

  it("explains invalid files", () => {
    const bad = readManifestForm("name: A\nrole: r\nmodel: nope\n");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("model");
    expect(readManifestForm("name: [").ok).toBe(false);
  });
});

describe("applyManifestForm", () => {
  it("returns the file unchanged when nothing changed", () => {
    expect(applyManifestForm(CAPTAIN, form(CAPTAIN))).toBe(CAPTAIN);
  });

  it("keeps comments, order and unknown tools while changing one field", () => {
    const next = applyManifestForm(CAPTAIN, { ...form(CAPTAIN), mcp: ["memory"] });
    expect(next).toContain("# The coordinator");
    expect(next).toMatch(/^mcp: \[ ?memory ?\]/m);
    expect(next.indexOf("mcp:")).toBeLessThan(next.indexOf("skills:"));
    expect(form(next).tools).toEqual(["read", "write", "edit", "bash", "web_fetch"]);
  });

  it("writes cli settings, never-for approvals and caps, then reads them back", () => {
    const f = {
      ...form(CAPTAIN),
      backend: "claude-code-cli" as const,
      cliModel: "sonnet",
      cliAllowedTools: ["Read", "Bash(git *)"],
      cliPermissionMode: "acceptEdits" as const,
      approval: "never-for" as const,
      neverFor: ["bash"],
      allow: ["read"],
      monthlyCapUsd: 12.5,
      visibility: "private" as const,
      avatar: "anchor.png",
    };
    const next = applyManifestForm(CAPTAIN, f);
    expect(form(next)).toEqual(f);
  });

  it("removes optional fields that are cleared", () => {
    const withCli = applyManifestForm(CAPTAIN, { ...form(CAPTAIN), cliModel: "opus", avatar: "a" });
    const cleared = applyManifestForm(withCli, { ...form(withCli), cliModel: "", avatar: "" });
    expect(cleared).not.toContain("avatar");
    expect(cleared).not.toContain("opus");
  });
});

describe("cleanList", () => {
  it("trims and drops blanks and duplicates", () => {
    expect(cleanList([" a", "", "b", "a "])).toEqual(["a", "b"]);
  });
});

describe("Claude Code tool groups", () => {
  it("ticks and unticks groups, keeping other rules", () => {
    const allowed = ["Bash(npm test)", "Edit(./**)"];
    expect(hasToolGroup(allowed, ["Edit(./**)"])).toBe(true);
    expect(hasToolGroup(allowed, ["Bash"])).toBe(false);
    expect(setToolGroup(allowed, ["Bash"], true)).toEqual(["Bash(npm test)", "Edit(./**)", "Bash"]);
    expect(setToolGroup(allowed, ["Edit(./**)"], false)).toEqual(["Bash(npm test)"]);
    expect(otherCliTools(allowed)).toEqual(["Bash(npm test)"]);
  });
});

describe("helper agents and engine", () => {
  it("reads and writes helpers", () => {
    const yaml = "name: A\nrole: r\nmodel: faux/m\n";
    expect(form(yaml).helpers).toBe(false);
    const out = applyManifestForm(yaml, { ...form(yaml), helpers: true });
    expect(out).toContain("helpers: true");
    expect(form(out).helpers).toBe(true);
  });

  it("switches engines without leaving a model the engine cannot run", () => {
    const pi = form("name: A\nrole: r\nmodel: faux/m\n");
    expect(switchEngine(pi, "pi")).toEqual({});
    expect(switchEngine(pi, "claude-code-cli")).toEqual({ backend: "claude-code-cli" });
    const cli = form("name: A\nrole: r\nmodel: claude-code/opus\nbackend: claude-code-cli\n");
    expect(switchEngine(cli, "pi")).toEqual({ backend: "pi", model: "default" });
    const cliOnDefault = form("name: A\nrole: r\nmodel: default\nbackend: claude-code-cli\n");
    expect(switchEngine(cliOnDefault, "pi")).toEqual({ backend: "pi" });
  });

  it("moves to and from Codex, and picks the engine from the model", () => {
    const pi = form("name: A\nrole: r\nmodel: default\n");
    expect(switchEngine(pi, "codex-cli")).toEqual({ backend: "codex-cli" });
    const codex = form("name: A\nrole: r\nmodel: codex/gpt-6.1-sol\nbackend: codex-cli\n");
    expect(codex.codexSandbox).toBe("read-only");
    expect(switchEngine(codex, "pi")).toEqual({ backend: "pi", model: "default" });
    expect(engineFor("codex/gpt-6.1-sol")).toBe("codex-cli");
    expect(engineFor("claude-code/opus")).toBe("claude-code-cli");
    expect(engineFor("chatgpt/gpt-6.1-sol")).toBe("pi");
  });

  it("writes Codex's sandbox into crew.yaml", () => {
    const yaml = "name: A\nrole: r\nmodel: codex/gpt-6.1-sol\nbackend: codex-cli\n";
    const out = applyManifestForm(yaml, { ...form(yaml), codexSandbox: "workspace-write" });
    expect(out).toContain("codex:\n  sandbox: workspace-write");
    expect(form(out).codexSandbox).toBe("workspace-write");
  });
});
