import { describe, expect, it } from "vitest";
import { describeStatus } from "./claude-cli.js";

describe("claude-cli helpers", () => {
  it("describes the CLI status", () => {
    const base = { version: null, authMethod: null, configDir: "/data/claude", docs: "" };
    expect(describeStatus({ ...base, installed: false, signedIn: false }).label).toBe(
      "Not installed",
    );
    expect(describeStatus({ ...base, installed: true, signedIn: false }).tone).toBe("warn");
    expect(describeStatus({ ...base, installed: true, signedIn: true }).tone).toBe("ok");
  });
});
