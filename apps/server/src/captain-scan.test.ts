import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { childEnv } from "@shipmate/crew";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliAllowedTools } from "./claude-cli-turn.js";
import { browserArgs } from "./services/mcp.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

describe("crew environment and servers", () => {
  it("keeps NODE_ENV and Shipmate's secrets out of crew commands", () => {
    const env = childEnv({ NODE_ENV: "production", PATH: "/bin", DATABASE_URL: "x" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("allows the tools of the MCP servers a Claude Code crew member was given", () => {
    const tools = cliAllowedTools("/data/crew/bosun", [], true, false, ["browser", "fetch"]);
    expect(tools).toEqual(expect.arrayContaining(["mcp__shipmate", "mcp__browser", "mcp__fetch"]));
    // Without Shipmate's tool server there is no approval hook either, so nothing is added.
    expect(cliAllowedTools("/data/crew/bosun", [], false, false, ["browser"])).not.toContain(
      "mcp__browser",
    );
  });

  it("points the browser at the image's Chromium, with a profile of its own each time", () => {
    expect(browserArgs({ SHIPMATE_BROWSER_PATH: "/usr/bin/chromium" })).toEqual([
      "--isolated",
      "--executable-path",
      "/usr/bin/chromium",
    ]);
    expect(browserArgs({})).toEqual(["--isolated"]);
  });
});

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("fixes from the Captain's own scan", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };
  const send = async (responses: Parameters<typeof t.faux.setResponses>[0]) => {
    t.faux.setResponses(responses);
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "go" }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    return { events, conv };
  };
  /** Run Captain tool calls in order; returns the text of each tool result. */
  const tools = async (calls: Array<[string, Record<string, unknown>]>) => {
    const results: string[] = [];
    await send([
      ...calls.map(([name, args]) => fauxAssistantMessage([fauxToolCall(name, args as never)])),
      (context) => {
        for (const m of context.messages) {
          if (m.role === "toolResult") {
            results.push(m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
          }
        }
        return fauxAssistantMessage("Done.");
      },
    ]);
    return results;
  };
  const yaml = async (slug: string) =>
    (await api("GET", `/api/crew/${slug}`)).json().crew.manifestYaml as string;

  beforeAll(async () => {
    t = await testApp(db as string);
    const res = await api("POST", "/api/setup", {
      email: "owner@example.com",
      displayName: "Addison",
      password: "correct horse",
    });
    cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    await api("PUT", "/api/crew/captain", {
      manifestYaml: (await yaml("captain")).replace(/^model: .*$/m, "model: faux/m"),
    });
    await api("POST", "/api/crew", {
      slug: "bosun",
      name: "Bosun",
      role: "web errands",
      persona: "# Bosun",
    });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("refuses model names Shipmate can't run and keeps one model setting", async () => {
    await api("PUT", "/api/crew/bosun", {
      manifestYaml: `${await yaml("bosun")}\nbackend: claude-code-cli\ncli:\n  model: sonnet\n`,
    });
    const results = await tools([
      ["edit_crew_member", { slug: "bosun", model: "openai-codex/gpt-5.1-codex-mini" }],
      [
        "recruit_crew_member",
        { slug: "painter", name: "Painter", role: "pictures", persona: "# P", model: "gpt-4" },
      ],
      ["edit_crew_member", { slug: "bosun", model: "claude-code/opus" }],
      ["list_models", {}],
    ]);
    expect(results[0]).toContain('"openai-codex/gpt-5.1-codex-mini" is not a model');
    expect(results[0]).toContain("faux/m");
    expect(results[1]).toContain('"gpt-4" is not a model');
    const bosun = await yaml("bosun");
    expect(bosun).toMatch(/^model: claude-code\/opus$/m);
    expect(bosun).toMatch(/^backend: claude-code-cli$/m);
    expect(bosun).not.toContain("sonnet");
    expect(results[3]).toContain("Crew default (Settings");
    expect(results[3]).toContain("faux/m");
  });

  it("lists the MCP catalog and explains tools: []", async () => {
    await api("PUT", "/api/crew/bosun", {
      manifestYaml: "name: Bosun\nrole: web errands\nmodel: default\ntools: []\n",
    });
    const [catalog, settings] = await tools([
      ["list_mcp_catalog", {}],
      ["crew_settings", { slug: "bosun" }],
    ]);
    expect(catalog).toContain("- weather: Weather.");
    expect(catalog).toContain("not installed");
    expect(catalog).toMatch(/- web-search: .*needs SearXNG URL or Brave API key/);
    expect(settings).toContain("tools: [] means all built-in tools");
    const servers = (await api("GET", "/api/mcp")).json().servers as Array<{
      id: string;
      ready: boolean;
    }>;
    expect(servers.find((s) => s.id === "web-search")?.ready).toBe(false);
  });

  it("hands the Captain what a crew member had when its turn failed", async () => {
    let handed = "";
    await send([
      fauxAssistantMessage([fauxToolCall("delegate", { crew: "bosun", task: "build it" })]),
      fauxAssistantMessage([fauxText("Made package.json.")], {
        stopReason: "error",
        errorMessage: "the provider gave up",
      }),
      (context) => {
        const last = context.messages.at(-1);
        if (last?.role === "toolResult") {
          handed = last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        }
        return fauxAssistantMessage("Bosun got partway.");
      },
    ]);
    expect(handed).toContain("Bosun stopped before finishing: the provider gave up");
    expect(handed).toContain("Made package.json.");
  });

  it("says so when a crew member's model isn't set up instead of quietly swapping", async () => {
    await api("PUT", "/api/crew/captain", {
      manifestYaml: (await yaml("captain")).replace(/^model: .*$/m, "model: faux/gone"),
    });
    const { events } = await send([fauxAssistantMessage("Hi.")]);
    const notes = events.flatMap((e) =>
      e.type === "message" && e.message.role === "system" ? [e.message.content] : [],
    );
    expect(notes.join("\n")).toContain("model faux/gone isn't set up");
  });
});
