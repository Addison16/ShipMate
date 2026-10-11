import { describe, expect, it } from "vitest";
import { describeStatus, readBackend, withBackend } from "./claude-cli.js";

describe("claude-cli helpers", () => {
  it("reads the backend, defaulting to pi", () => {
    expect(readBackend("name: A\nmodel: faux/m\n")).toBe("pi");
    expect(readBackend("name: A\nbackend: claude-code-cli\n")).toBe("claude-code-cli");
    expect(readBackend('backend: "claude-code-cli" # sub\n')).toBe("claude-code-cli");
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
