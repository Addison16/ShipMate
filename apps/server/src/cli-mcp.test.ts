import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { loopbackHost } from "./app.js";
import { CliToolServer } from "./cli-mcp.js";

const echo = {
  name: "echo",
  label: "Echo",
  description: "Say it back.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(_id: string, p: { text: string }) {
    return { content: [{ type: "text" as const, text: `echo: ${p.text}` }], details: undefined };
  },
} as unknown as ToolDefinition;

const tokenOf = (mcpConfig: string) =>
  String(JSON.parse(mcpConfig).mcpServers.shipmate.headers.Authorization).slice("Bearer ".length);

describe("CliToolServer", () => {
  it("runs installed MCP servers in the CLI behind the approval hook", async () => {
    const s = new CliToolServer();
    s.setBaseUrl("http://127.0.0.1:3000");
    const asked: string[] = [];
    const grant = s.open(
      {
        tools: [echo],
        gate: async ({ toolName }) => {
          asked.push(toolName);
          return toolName.endsWith("send_gmail_message")
            ? { block: true as const, reason: "The person declined this action." }
            : undefined;
        },
      },
      {
        "google-workspace": {
          command: "uvx",
          args: ["workspace-mcp", "--single-user"],
          env: { USER_GOOGLE_EMAIL: "me@example.com" },
          exposure: "direct",
        },
        notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer n" } },
      } as never,
    );
    if (!grant) throw new Error("no grant");
    const servers = JSON.parse(grant.mcpConfig).mcpServers;
    expect(servers["google-workspace"]).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["workspace-mcp", "--single-user"],
      env: { USER_GOOGLE_EMAIL: "me@example.com" },
    });
    expect(servers.notion).toEqual({
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer n" },
    });
    const hook = JSON.parse(grant.settingsJson ?? "{}").hooks.PreToolUse[0];
    expect(new RegExp(hook.matcher).test("mcp__google-workspace__list_calendars")).toBe(true);
    expect(new RegExp(hook.matcher).test("mcp__shipmate__remember")).toBe(false);
    expect(hook.hooks[0].command).toContain("http://127.0.0.1:3000/api/cli-mcp/gate");

    const token = tokenOf(grant.mcpConfig);
    const decision = (r: unknown) =>
      (r as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
        .permissionDecision;
    expect(
      decision(await s.gate(token, { tool_name: "mcp__google-workspace__list_calendars" })),
    ).toBe("allow");
    expect(
      decision(await s.gate(token, { tool_name: "mcp__google-workspace__send_gmail_message" })),
    ).toBe("deny");
    expect(asked).toEqual([
      "mcp__google-workspace__list_calendars",
      "mcp__google-workspace__send_gmail_message",
    ]);
    grant.revoke();
    expect(decision(await s.gate(token, { tool_name: "mcp__google-workspace__x" }))).toBe("deny");
  });

  it("adds no hook when the crew member has no MCP servers", () => {
    const s = new CliToolServer();
    s.setBaseUrl("http://127.0.0.1:3000");
    expect(s.open({ tools: [echo], gate: async () => undefined })?.settingsJson).toBeUndefined();
  });

  it("serves nothing until the server listens", () => {
    const s = new CliToolServer();
    expect(s.open({ tools: [echo], gate: async () => undefined })).toBeUndefined();
  });

  it("lists and calls a turn's tools, and forgets them on revoke", async () => {
    const s = new CliToolServer();
    s.setBaseUrl("http://127.0.0.1:3000/");
    const grant = s.open({ tools: [echo], gate: async () => undefined });
    if (!grant) throw new Error("no grant");
    const config = JSON.parse(grant.mcpConfig);
    expect(config.mcpServers.shipmate).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:3000/api/cli-mcp",
    });
    const token = tokenOf(grant.mcpConfig);

    const init = (await s.handle(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    })) as { result: { protocolVersion: string; capabilities: object } };
    expect(init.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
    });
    expect(await s.handle(token, { jsonrpc: "2.0", method: "notifications/initialized" })).toBe(
      undefined,
    );

    const list = (await s.handle(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: { name: string; inputSchema: { properties: object } }[] };
    };
    expect(list.result.tools).toEqual([
      expect.objectContaining({
        name: "echo",
        inputSchema: expect.objectContaining({ properties: { text: { type: "string" } } }),
      }),
    ]);

    expect(
      await s.handle(token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "echo: hi" }], isError: false },
    });
    expect(
      await s.handle(token, { jsonrpc: "2.0", id: 4, method: "resources/list" }),
    ).toMatchObject({ error: { code: -32601 } });

    grant.revoke();
    expect(s.has(token)).toBe(false);
    expect(await s.handle(token, { jsonrpc: "2.0", id: 5, method: "tools/list" })).toBeUndefined();
  });

  it("applies the approval gate before running a tool", async () => {
    const s = new CliToolServer();
    s.setBaseUrl("http://127.0.0.1:3000");
    const seen: string[] = [];
    const grant = s.open({
      tools: [echo],
      gate: async (call) => {
        seen.push(call.toolName);
        return { block: true, reason: "The person declined this action." };
      },
    });
    if (!grant) throw new Error("no grant");
    const res = await s.handle(tokenOf(grant.mcpConfig), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    expect(seen).toEqual(["echo"]);
    expect(res).toMatchObject({
      result: { isError: true, content: [{ text: "The person declined this action." }] },
    });
  });

  it("reaches a wildcard listen address over loopback", () => {
    expect(loopbackHost("0.0.0.0")).toBe("127.0.0.1");
    expect(loopbackHost("::")).toBe("127.0.0.1");
    expect(loopbackHost("::1")).toBe("[::1]");
    expect(loopbackHost("10.0.0.5")).toBe("10.0.0.5");
  });
});
