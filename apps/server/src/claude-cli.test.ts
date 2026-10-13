import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { CrewManifest, type ServerEvent } from "@shipmate/core";
import { claudeCliArgs, claudeCliBilling, runClaudeCli } from "@shipmate/crew";
import type { Db } from "@shipmate/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCliTurns, cliModelFromRef } from "./claude-cli-turn.js";
import { chatGptProvider } from "./services/chatgpt.js";
import { callCost } from "./services/usage.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/**
 * A stand-in for the `claude` binary: prints stream-json like `claude -p --output-format
 * stream-json --verbose --include-partial-messages`, logs each call to $FAKE_CLAUDE_LOG.
 * Prompts containing "hang" never finish; "fail" ends in an error result.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = (o) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") {
  const ok = process.env.FAKE_CLAUDE_SIGNED_IN !== "0";
  console.log(JSON.stringify({ loggedIn: ok, authMethod: ok ? "claude.ai" : "none" }, null, 2));
  process.exit(ok ? 0 : 1);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const resume = at("--resume");
  const sid = resume || "sess-" + Math.random().toString(36).slice(2, 8);
  log({ args, cwd: process.cwd(), prompt, pid: process.pid, leaked: Object.keys(process.env).filter((k) => k.startsWith("SHIPMATE_")) });
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", session_id: sid, model: "claude-fake-1", tools: ["Read"], ...(process.env.FAKE_CLAUDE_KEY_SOURCE === "omit" ? {} : { apiKeySource: process.env.FAKE_CLAUDE_KEY_SOURCE || "none" }) });
  if (prompt.includes("hang")) { setInterval(() => {}, 1000); return; }
  // "route <slug> <task>": call Shipmate's delegate tool over the MCP server in --mcp-config.
  const mcp = at("--mcp-config");
  if (prompt.startsWith("route ")) {
    const srv = mcp ? JSON.parse(mcp).mcpServers.shipmate : null;
    const say = (id, text) => out({ type: "assistant", session_id: sid, message: { id, content: [{ type: "text", text }] } });
    if (!srv) {
      say("m1", "No tools.");
      out({ type: "result", subtype: "success", is_error: false, result: "No tools.", session_id: sid, total_cost_usd: 0, usage: {} });
      return;
    }
    const rpc = async (method, params, id) => {
      const res = await fetch(srv.url, { method: "POST", headers: { ...srv.headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
      return res.status === 202 ? null : res.json();
    };
    (async () => {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } }, 1);
      await rpc("notifications/initialized", {});
      const list = await rpc("tools/list", {}, 2);
      const names = list.result.tools.map((t) => t.name).sort().join(",");
      const [, crew, ...task] = prompt.trim().split(" ");
      say("m1", "Routing to " + crew + ".");
      out({ type: "assistant", session_id: sid, message: { id: "m2", content: [{ type: "tool_use", id: "tu9", name: "mcp__shipmate__delegate", input: { crew, task: task.join(" ") } }] } });
      const r = await rpc("tools/call", { name: "delegate", arguments: { crew, task: task.join(" ") } }, 3);
      const reply = r.result.content[0].text;
      out({ type: "user", session_id: sid, message: { content: [{ type: "tool_result", tool_use_id: "tu9", content: reply, is_error: r.result.isError }] } });
      const final = "Wrapped up (" + init.result.serverInfo.name + ": " + names + "): " + reply;
      say("m3", final);
      out({ type: "result", subtype: "success", is_error: false, result: final, session_id: sid, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 } });
    })();
    return;
  }
  if (prompt.includes("fail")) {
    out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", session_id: sid, total_cost_usd: 0, usage: {} });
    return;
  }
  const delta = (text) => out({ type: "stream_event", parent_tool_use_id: null, session_id: sid, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  delta("Hello ");
  delta("there");
  out({ type: "assistant", session_id: sid, message: { id: "m1", content: [{ type: "text", text: "Hello there" }] } });
  out({ type: "assistant", session_id: sid, message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "notes.md" } }] } });
  out({ type: "user", session_id: sid, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "the notes", is_error: false }] } });
  // No partial deltas for this one: the full message carries the text.
  out({ type: "assistant", session_id: sid, message: { id: "m2", content: [{ type: "text", text: "Done: " + prompt.trim() }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "Hello there\\n\\nDone: " + prompt.trim(), session_id: sid, total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }, modelUsage: { "claude-fake-1": {} } });
});
`;

const dir = mkdtempSync(join(tmpdir(), "shipmate-fake-claude-"));
const fakeBin = join(dir, "claude");
const logFile = join(dir, "calls.jsonl");
writeFileSync(fakeBin, FAKE_CLAUDE);
chmodSync(fakeBin, 0o755);

interface Call {
  args: string[];
  cwd: string;
  prompt: string;
  pid: number;
  leaked: string[];
}
const calls = (): Call[] =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Call)
    : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

describe("claude-code-cli backend: manifest and runner", () => {
  it("keeps existing manifests valid and defaults to pi", () => {
    const m = CrewManifest.parse({ name: "A", role: "b", model: "faux/m" });
    expect(m.backend).toBe("pi");
    expect(m.cli).toBeUndefined();
    const c = CrewManifest.parse({
      name: "A",
      role: "b",
      model: "claude-code/sonnet",
      backend: "claude-code-cli",
      cli: { allowedTools: ["Read", "Bash(git *)"] },
    });
    expect(c.cli).toEqual({ allowedTools: ["Read", "Bash(git *)"], permissionMode: "dontAsk" });
    expect(() =>
      CrewManifest.parse({ name: "A", role: "b", model: "x/y", backend: "x" }),
    ).toThrow();
    expect(cliModelFromRef("claude-code/opus")).toBe("opus");
    expect(cliModelFromRef("openai/gpt-5.5")).toBeUndefined();
  });

  it("builds a print-mode command line with a conservative permission mode", () => {
    const args = claudeCliArgs({
      appendSystemPrompt: "# Persona",
      resume: "abc",
      settings: { model: "sonnet", allowedTools: ["Read", "Edit"] },
    });
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(args).toContain("--include-partial-messages");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Edit");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("# Persona");
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("streams a run and reports usage", async () => {
    const events: string[] = [];
    const r = await runClaudeCli({
      bin: fakeBin,
      cwd: dir,
      prompt: "hi",
      onEvent: (e) => events.push(e.type === "text" ? `text:${e.text}` : e.type),
    });
    expect(events).toEqual([
      "init",
      "text:Hello ",
      "text:there",
      "tool_start",
      "tool_end",
      "text:Done: hi",
    ]);
    expect(r).toMatchObject({
      isError: false,
      costUsd: 0.0123,
      model: "claude-fake-1",
      apiKeySource: "none",
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 },
    });
    expect(r.sessionId).toMatch(/^sess-/);
  });

  it("tells subscription runs from API-key runs", async () => {
    const run = (source?: string) =>
      runClaudeCli({
        bin: fakeBin,
        cwd: dir,
        prompt: "hi",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "",
          ...(source ? { FAKE_CLAUDE_KEY_SOURCE: source } : {}),
        },
      });
    expect(claudeCliBilling(await run())).toBe("subscription");
    const keyed = await run("ANTHROPIC_API_KEY");
    expect(keyed.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(claudeCliBilling(keyed)).toBe("api");
    // Older CLIs do not report a source: an API key in the environment decides.
    expect(claudeCliBilling(await run("omit"))).toBe("subscription");
    const old = await runClaudeCli({
      bin: fakeBin,
      cwd: dir,
      prompt: "hi",
      env: { ...process.env, FAKE_CLAUDE_KEY_SOURCE: "omit", ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(claudeCliBilling(old)).toBe("api");
  });

  it("prices subscription calls at API rates without counting them as spend", () => {
    const usage = {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    // ChatGPT-plan models are registered at zero cost; the estimate uses OpenAI's API prices.
    const plan = chatGptProvider({ accessToken: async () => "", configures: () => false })
      .getModels()
      .find((m) => m.cost.input === 0 && m.id.startsWith("gpt-"));
    expect(plan).toBeDefined();
    const c = callCost(plan as NonNullable<typeof plan>, usage);
    expect(c.billing).toBe("subscription");
    expect(c.costMicroUsd).toBe(0);
    expect(c.apiEquivalentMicroUsd).toBeGreaterThan(0);
    // The Claude Code CLI's own reported cost is the estimate; on an API key it is spend.
    const cli = { provider: "claude-code", id: "opus", cost: usage.cost } as unknown as Parameters<
      typeof callCost
    >[0];
    const reported = { ...usage, cost: { ...usage.cost, total: 0.25 } };
    expect(callCost(cli, reported)).toEqual({
      billing: "subscription",
      costMicroUsd: 0,
      apiEquivalentMicroUsd: 250_000,
    });
    expect(callCost(cli, reported, "api")).toEqual({
      billing: "api",
      costMicroUsd: 250_000,
      apiEquivalentMicroUsd: 0,
    });
  });

  it("refuses Shipyard project conversations (it would run outside the sandbox)", async () => {
    const turns = new ClaudeCliTurns(null as unknown as Db);
    const input = {
      conv: { id: "c", projectId: "p", sessionFiles: {} },
      folder: { slug: "s", dir, persona: "", manifest: { name: "Scribe" } },
    } as unknown as Parameters<ClaudeCliTurns["turn"]>[0];
    await expect(turns.turn(input)).rejects.toThrow(/Shipyard/);
  });

  it("fails clearly when the binary is missing", async () => {
    await expect(
      runClaudeCli({ bin: join(dir, "no-such-claude"), cwd: dir, prompt: "hi" }),
    ).rejects.toThrow(/Claude Code CLI .* is not installed/);
  });
});

describe.skipIf(!db)("claude-code-cli backend through the Bridge", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let sql: postgres.Sql;
  let ownerCookie = "";
  let memberCookie = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie = ownerCookie) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  /** Open a socket, run `act`, and collect events until the turn is idle again. */
  const turn = async (conversationId: string, text: string, during?: () => Promise<void>) => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId, text }));
    if (during) await during();
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    return { events, ws };
  };

  let convId = "";

  beforeAll(async () => {
    process.env.SHIPMATE_CLAUDE_BIN = fakeBin;
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.SHIPMATE_TEST_LEAK = "must-not-reach-the-cli";
    t = await testApp(db as string, { watches: false });
    sql = postgres(db as string, { max: 2, onnotice: () => {} });
    ownerCookie = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    await api("POST", "/api/users", {
      email: "m@example.com",
      displayName: "Member",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "m@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    const created = await api("POST", "/api/crew", {
      slug: "scribe",
      manifestYaml:
        "name: Scribe\nrole: writing\nmodel: claude-code/sonnet\nbackend: claude-code-cli\ncli:\n  allowedTools: [Read]\n",
      persona: "# Scribe\nYou write things down.",
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().crew.manifestYaml).toContain("backend: claude-code-cli");
    convId = (
      await api("POST", "/api/conversations", { kind: "direct", crewSlug: "scribe" })
    ).json().conversation.id;
  });

  afterAll(async () => {
    delete process.env.SHIPMATE_CLAUDE_BIN;
    delete process.env.SHIPMATE_TEST_LEAK;
    await sql?.end();
    await t?.app.close();
  });

  it("streams a full CLI turn into messages and records its usage", async () => {
    const before = calls().length;
    const { events, ws } = await turn(convId, "write a haiku");
    ws.terminate();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const deltas = events
      .filter((e) => e.type === "delta")
      .map((e) => (e.type === "delta" ? e.text : ""))
      .join("");
    expect(deltas).toBe("Hello there\n\nDone: write a haiku");
    const tools = events.filter((e) => e.type === "tool");
    expect(tools.map((e) => (e.type === "tool" ? `${e.phase}:${e.toolName}` : ""))).toEqual([
      "start:Read",
      "end:Read",
    ]);

    const msgs = (await api("GET", `/api/conversations/${convId}/messages`)).json().messages;
    const reply = msgs.at(-1);
    expect(reply).toMatchObject({
      role: "assistant",
      content: "Hello there\n\nDone: write a haiku",
      author: { kind: "crew", slug: "scribe" },
      meta: { tools: ["Read"] },
    });

    const [usage] = await sql`select * from usage_events where conversation_id = ${convId}`;
    // Signed in with a Claude subscription: not spend, but its API-price estimate is kept.
    expect(usage).toMatchObject({ model: "claude-code/claude-fake-1", billing: "subscription" });
    expect(Number(usage?.cost_micro_usd)).toBe(0);
    expect(Number(usage?.api_equivalent_micro_usd)).toBe(12300);
    expect(Number(usage?.input_tokens)).toBe(100);
    expect(Number(usage?.cache_write_tokens)).toBe(7);

    const call = calls()[before];
    expect(call?.prompt).toBe("write a haiku");
    expect(call?.cwd).toMatch(/scribe[/\\]cli-workspace$/);
    expect(call?.leaked).toEqual([]);
    const args = call?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    const allowed = (args[args.indexOf("--allowedTools") + 1] ?? "").split(",");
    // Its own tools, plus reading its own folder and web lookups out of the box.
    expect(allowed).toContain("Read");
    expect(allowed).toContain("WebSearch");
    expect(allowed.find((a) => a.startsWith("Read(//"))).toMatch(
      /^Read\(\/\/.*scribe\/cli-workspace\/\*\*\)$/,
    );
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("You write things down.");
    expect(args).not.toContain("--resume");
  });

  it("persists the CLI session id and resumes it on the next message", async () => {
    const [conv] = await sql`select session_files from conversations where id = ${convId}`;
    const files = (conv?.session_files ?? {}) as Record<string, string>;
    const sid = files["claude-cli:scribe"];
    expect(sid).toMatch(/^sess-/);
    const before = calls().length;
    const { ws } = await turn(convId, "and another");
    ws.terminate();
    const args = calls()[before]?.args ?? [];
    expect(args[args.indexOf("--resume") + 1]).toBe(sid);
  });

  it("cancel kills the CLI process", async () => {
    const before = calls().length;
    let pid = 0;
    const { events, ws } = await turn(convId, "please hang", async () => {
      await until(() => calls().length > before);
      pid = calls()[before]?.pid ?? 0;
      expect(alive(pid)).toBe(true);
      const sock = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
      sock.send(JSON.stringify({ type: "abort", conversationId: convId }));
      setTimeout(() => sock.terminate(), 200);
    });
    ws.terminate();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    await until(() => !alive(pid));
  });

  it("reports CLI errors with the sign-in hint", async () => {
    const { events, ws } = await turn(convId, "fail please");
    ws.terminate();
    const err = events.find((e) => e.type === "error");
    expect(err?.type === "error" && err.message).toMatch(
      /Please run \/login[\s\S]*docker exec -it shipmate claude/,
    );
  });

  it("gives a clear error when the binary is missing", async () => {
    process.env.SHIPMATE_CLAUDE_BIN = join(dir, "missing-claude");
    try {
      const { events, ws } = await turn(convId, "hello");
      ws.terminate();
      const err = events.find((e) => e.type === "error");
      expect(err?.type === "error" && err.message).toMatch(/not installed on this server/);
    } finally {
      process.env.SHIPMATE_CLAUDE_BIN = fakeBin;
    }
  });

  it("lets the Captain delegate to a CLI crew member", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxText("Asking Scribe."),
        fauxToolCall("delegate", { crew: "scribe", task: "note the date" }),
      ]),
      fauxAssistantMessage("Scribe has it."),
    ]);
    const { events, ws } = await turn(conv.id, "Write down the date");
    ws.terminate();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.find((e) => e.type === "handoff")).toMatchObject({ to: { slug: "scribe" } });
    const msgs = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(msgs.map((m: { author: { slug?: string } }) => m.author.slug ?? "user")).toEqual([
      "user",
      "captain",
      "scribe",
      "captain",
    ]);
    expect(msgs[2].content).toContain("Done: note the date");
  });

  it("lets a Captain on the CLI route a message to a crew member", async () => {
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const deck = await api("POST", "/api/crew", {
      slug: "deckhand",
      manifestYaml: "name: Deckhand\nrole: odd jobs\nmodel: faux/m\n",
      persona: "# Deckhand",
    });
    expect(deck.statusCode).toBe(200);
    const detail = (await api("GET", "/api/crew/captain")).json().crew;
    const yaml = `${detail.manifestYaml.replace(/^backend:.*\n?/m, "").trimEnd()}\nbackend: claude-code-cli\n`;
    expect((await api("PUT", "/api/crew/captain", { manifestYaml: yaml })).statusCode).toBe(200);
    try {
      const conv = (await api("POST", "/api/conversations", {})).json().conversation;
      t.faux.setResponses([fauxAssistantMessage("Deck swabbed.")]);
      const before = calls().length;
      const { events, ws } = await turn(conv.id, "route deckhand swab the deck");
      ws.terminate();
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(events.find((e) => e.type === "handoff")).toMatchObject({
        from: { slug: "captain" },
        to: { slug: "deckhand" },
        task: "swab the deck",
      });
      // The hand-off shows as bubbles, not as a tool chip.
      expect(events.some((e) => e.type === "tool" && e.toolName.includes("delegate"))).toBe(false);

      const msgs = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
      expect(
        msgs.map((m: { author: { slug?: string }; content: string }) => [
          m.author.slug ?? "user",
          m.content,
        ]),
      ).toEqual([
        ["user", "route deckhand swab the deck"],
        ["captain", "Routing to deckhand."],
        ["deckhand", "Deck swabbed."],
        [
          "captain",
          expect.stringMatching(
            /^Wrapped up \(shipmate: .*delegate.*list_crew.*\): Deck swabbed\.$/,
          ),
        ],
      ]);

      const args = calls()[before]?.args ?? [];
      expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__shipmate");
      expect(args[args.indexOf("--append-system-prompt") + 1]).toMatch(
        /deckhand: Deckhand, odd jobs[\s\S]*`delegate`/,
      );
      // The turn's token stops working once the turn ends.
      const config = JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "{}");
      const server = config.mcpServers.shipmate;
      const late = await t.app.inject({
        method: "POST",
        url: "/api/cli-mcp",
        headers: server.headers,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(late.statusCode).toBe(404);

      // A crew member's ask_captain reaches the CLI Captain as a one-off answer.
      const direct = (
        await api("POST", "/api/conversations", { kind: "direct", crewSlug: "deckhand" })
      ).json().conversation;
      t.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("ask_captain", { question: "port or starboard?" })]),
        fauxAssistantMessage("Starboard it is."),
      ]);
      const asked = calls().length;
      const consult = await turn(direct.id, "which side?");
      consult.ws.terminate();
      expect(consult.events.find((e) => e.type === "error")).toBeUndefined();
      const call = calls()[asked];
      expect(call?.prompt).toContain("port or starboard?");
      expect(call?.args).not.toContain("--resume");
      expect(call?.args).not.toContain("--mcp-config");
      const dm = (await api("GET", `/api/conversations/${direct.id}/messages`)).json().messages;
      expect(dm.map((m: { author: { slug?: string } }) => m.author.slug ?? "user")).toEqual([
        "user",
        "captain",
        "deckhand",
      ]);
      expect(dm[1].content).toContain("Done:");
    } finally {
      await api("PUT", "/api/crew/captain", { manifestYaml: detail.manifestYaml });
    }
  });

  it("reports CLI status to admins only", async () => {
    const res = await api("GET", "/api/claude-cli");
    expect(res.statusCode).toBe(200);
    expect(res.json().claudeCli).toMatchObject({
      installed: true,
      version: "9.9.9",
      signedIn: true,
      authMethod: "claude.ai",
    });
    expect(res.json().claudeCli.docs).toContain("docker exec -it shipmate claude");
    expect(res.json().claudeCli.configDir).toBeTruthy();

    process.env.FAKE_CLAUDE_SIGNED_IN = "0";
    try {
      expect((await api("GET", "/api/claude-cli")).json().claudeCli.signedIn).toBe(false);
    } finally {
      delete process.env.FAKE_CLAUDE_SIGNED_IN;
    }

    process.env.SHIPMATE_CLAUDE_BIN = join(dir, "missing-claude");
    try {
      expect((await api("GET", "/api/claude-cli")).json().claudeCli).toMatchObject({
        installed: false,
        signedIn: false,
        version: null,
      });
    } finally {
      process.env.SHIPMATE_CLAUDE_BIN = fakeBin;
    }

    expect((await api("GET", "/api/claude-cli", undefined, memberCookie)).statusCode).toBe(403);
  });
});
