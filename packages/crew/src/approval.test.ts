import { describe, expect, it } from "vitest";
import { isConsequential, matches } from "./approval.js";

describe("approval rules", () => {
  it("treats the shell, instance changes and acting MCP tools as consequential", () => {
    expect(isConsequential("bash")).toBe(true);
    expect(isConsequential("create_watch")).toBe(true);
    expect(isConsequential("mcp__github__create_pull_request")).toBe(true);
    expect(isConsequential("mcp__gmail__send_email")).toBe(true);
    expect(isConsequential("mcp__github__get_file_contents")).toBe(false);
    expect(isConsequential("mcp__time__get_current_time")).toBe(false);
    expect(isConsequential("read")).toBe(false);
    expect(isConsequential("remember")).toBe(false);
  });
  it("matches wildcards", () => {
    expect(matches(["mcp__github__*"], "mcp__github__merge_pull_request")).toBe(true);
    expect(matches(["bash"], "bash")).toBe(true);
    expect(matches(["mcp__github__*"], "mcp__gitlab__x")).toBe(false);
  });
});
