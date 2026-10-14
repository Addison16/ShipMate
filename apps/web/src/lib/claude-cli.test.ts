import { describe, expect, it } from "vitest";
import { describeStatus, readBackend, usableModels, withBackend } from "./claude-cli.js";

describe("claude-cli helpers", () => {
  it("reads the backend, defaulting to pi", () => {
    expect(readBackend("name: A\nmodel: faux/m\n")).toBe("pi");
    expect(readBackend("name: A\nbackend: claude-code-cli\n")).toBe("claude-code-cli");
    expect(readBackend('backend: "claude-code-cli" # sub\n')).toBe("claude-code-cli");
    expect(readBackend("name: A\nbackend: codex-cli\n")).toBe("codex-cli");
  });
  it("sets the backend without touching other lines", () => {
    expect(withBackend("name: A\nmodel: faux/m\ntools: []\n", "claude-code-cli")).toBe(
      "name: A\nmodel: faux/m\nbackend: claude-code-cli\ntools: []\n",
    );
    expect(withBackend("name: A\nbackend: claude-code-cli\n", "pi")).toBe("name: A\nbackend: pi\n");
    expect(withBackend("name: A", "pi")).toBe("name: A\nbackend: pi\n");
  });
  it("describes the CLI status", () => {
    const base = { version: null, authMethod: null, configDir: "/data/claude", docs: "" };
    expect(describeStatus({ ...base, installed: false, signedIn: false }).label).toBe(
      "Not installed",
    );
    expect(describeStatus({ ...base, installed: true, signedIn: false }).tone).toBe("warn");
    expect(describeStatus({ ...base, installed: true, signedIn: true }).tone).toBe("ok");
  });
});

describe("usableModels", () => {
  const models = [
    { ref: "anthropic/claude-x", name: "Claude X", provider: "anthropic", available: true },
    { ref: "openai/gpt-x", name: "GPT X", provider: "openai", available: false },
    { ref: "xai/grok-x", name: "Grok X", provider: "xai", available: false },
  ];

  it("lists only models that something signed in can run", () => {
    expect(usableModels(models, false)).toEqual([
      { ref: "anthropic/claude-x", name: "Claude X", source: "anthropic" },
    ]);
  });

  it("adds the Claude Code models when the CLI is signed in", () => {
    const refs = usableModels([], true).map((m) => m.ref);
    expect(refs).toEqual(["claude-code/opus", "claude-code/sonnet", "claude-code/haiku"]);
    expect(usableModels(models, true)).toHaveLength(4);
  });
});
