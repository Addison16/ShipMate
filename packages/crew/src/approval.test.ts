import { describe, expect, it } from "vitest";
import { asksEveryTime, gateToolCall, isConsequential, matches } from "./approval.js";

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
  it("gates the Shipyard's GitHub writes but not its reads", () => {
    expect(isConsequential("git_push")).toBe(true);
    expect(isConsequential("open_pull_request")).toBe(true);
    expect(isConsequential("comment_on_github")).toBe(true);
    expect(isConsequential("list_issues")).toBe(false);
    expect(isConsequential("list_pull_requests")).toBe(false);
    expect(isConsequential("get_pull_request")).toBe(false);
  });
  it("matches wildcards", () => {
    expect(matches(["mcp__github__*"], "mcp__github__merge_pull_request")).toBe(true);
    expect(matches(["bash"], "bash")).toBe(true);
    expect(matches(["mcp__github__*"], "mcp__gitlab__x")).toBe(false);
  });
});

describe("gateToolCall", () => {
  const host = (answer: "allow" | "deny" | "always") => {
    const log = { asked: 0, remembered: [] as string[], decisions: [] as string[] };
    return {
      log,
      host: {
        request: async () => {
          log.asked++;
          return answer;
        },
        audit: (c: { decision: string }) => void log.decisions.push(c.decision),
        remember: async (t: string) => void log.remembered.push(t),
      },
    };
  };
  const call = { toolName: "approve_crew_member", input: { slug: "galley" } };

  it("always asks before a new crew member is approved, even on auto or the allow list", async () => {
    const a = host("allow");
    expect(
      await gateToolCall(
        { approval: "auto", allowed: new Set(["approve_crew_member"]) },
        a.host,
        call,
      ),
    ).toBeUndefined();
    expect(a.log.asked).toBe(1);

    const d = host("deny");
    expect(
      await gateToolCall({ approval: "auto", allowed: new Set() }, d.host, call),
    ).toMatchObject({
      block: true,
    });
  });

  it("treats always allow as a one-time yes there", async () => {
    const a = host("always");
    const allowed = new Set<string>();
    await gateToolCall({ approval: "ask", allowed }, a.host, call);
    expect(allowed.size).toBe(0);
    expect(a.log.remembered).toEqual([]);
    expect(a.log.decisions).toEqual(["approved"]);
  });

  it("always asks before a crew member gets more access", async () => {
    expect(asksEveryTime("equip_crew_member", { slug: "g", mcp: ["github"] })).toBe(true);
    expect(asksEveryTime("install_mcp_server", { id: "todoist", crews: [] })).toBe(true);
    expect(asksEveryTime("edit_crew_member", { slug: "g", mcp: ["github"] })).toBe(true);
    expect(asksEveryTime("edit_crew_member", { slug: "g", cliPermissionMode: "plan" })).toBe(true);
    expect(asksEveryTime("edit_crew_member", { slug: "g", backend: "claude-code-cli" })).toBe(true);
    expect(asksEveryTime("edit_crew_member", { slug: "g", skills: ["x"] })).toBe(true);
    expect(asksEveryTime("edit_crew_member", { slug: "g", role: "meals" })).toBe(false);
    expect(asksEveryTime("remember", {})).toBe(false);

    const requests: Array<{ everyTime?: boolean }> = [];
    const a = host("allow");
    await gateToolCall(
      { approval: "auto", allowed: new Set(["equip_crew_member"]) },
      {
        ...a.host,
        request: async (c) => {
          requests.push(c);
          return "allow";
        },
      },
      { toolName: "equip_crew_member", input: { slug: "g", mcp: ["github"] } },
    );
    expect(requests).toMatchObject([{ toolName: "equip_crew_member", everyTime: true }]);
  });
});
