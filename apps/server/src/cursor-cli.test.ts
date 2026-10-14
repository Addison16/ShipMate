import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CrewManifest, type ServerEvent } from "@shipmate/core";
import {
  CURSOR_FALLBACK_MODELS,
  cursorCliArgs,
  cursorCliStatus,
  cursorPermissions,
  cursorProjectFiles,
  cursorPrompt,
  parseCursorModels,
  readDenials,
  runCursorCli,
} from "@shipmate/crew";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onCrewDefault } from "./claude-cli-turn.js";
import {
  cursorBilling,
  cursorImageFile,
  cursorModelFromRef,
  cursorModels,
} from "./cursor-cli-turn.js";
import { callCost } from "./services/usage.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/**
 * A stand-in for the `cursor-agent` binary: prints JSON lines like `cursor-agent -p
 * --output-format stream-json` (event shapes from cursor-agent 2026.10.12) and logs each call to
 * $FAKE_CURSOR_LOG. Prompts containing "fail" end like a signed-out CLI; "draw ..." makes a
 * picture; "route <slug> <task>" calls Shipmate's delegate tool over the MCP server named in the
 * workspace's .cursor/mcp.json.
 */
const FAKE_CURSOR = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = (o) => process.env.FAKE_CURSOR_LOG && fs.appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("2026.10.12-fake"); process.exit(0); }
if (args[0] === "status") {
  const on = process.env.FAKE_CURSOR_SIGNED_IN !== "0";
  console.log(JSON.stringify(on ? { status: "authenticated", isAuthenticated: true, userInfo: { email: "a@example.com" } } : { status: "unauthenticated", isAuthenticated: false, message: "Not logged in" }, null, 2));
  process.exit(0);
}
if (args[0] === "models") {
  console.log("Available models\\n\\nauto - Auto (current)\\ncomposer-2.5 - Composer 2.5\\ngpt-5.5 - GPT-5.5 (default)\\n\\nTip: use --model <id> to switch.");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const ws = args[args.indexOf("--workspace") + 1];
  const r = args.indexOf("--resume");
  const resume = r >= 0 ? args[r + 1] : undefined;
  const file = (n) => { try { return JSON.parse(fs.readFileSync(path.join(ws, ".cursor", n), "utf8")); } catch { return null; } };
  const prompt = input.split("</shipmate-instructions>\\n\\n").pop().trim();
  log({ args, cwd: process.cwd(), input, prompt, home: process.env.HOME, cli: file("cli.json"), sandbox: file("sandbox.json"), mcp: file("mcp.json"), token: !!process.env.CURSOR_SHIPMATE_MCP_TOKEN, leaked: Object.keys(process.env).filter((k) => k.startsWith("SHIPMATE_")) });
  if (resume === "gone") { console.error("Error: chat not found: gone"); process.exit(1); }
  if (prompt.includes("fail")) { console.error("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable."); process.exit(1); }
  const sid = resume || "chat-" + Math.random().toString(36).slice(2, 8);
  const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + "\\n");
  const say = (text) => out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const done = (result) => out({ type: "result", subtype: "success", is_error: false, duration_ms: 5, result, request_id: "r1", usage: { inputTokens: 120, outputTokens: 14, cacheReadTokens: 80, cacheWriteTokens: 5 } });
  out({ type: "system", subtype: "init", apiKeySource: "login", cwd: process.cwd(), model: "GPT-5.5", permissionMode: "default" });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: input }] } });
  if (prompt.startsWith("draw ")) {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(path.join(ws, "boat.png"), png);
    const call = { args: { description: "a boat", filePath: "boat.png" } };
    out({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { generateImageToolCall: call } });
    out({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { generateImageToolCall: { ...call, result: { success: { filePath: path.join(ws, "boat.png") } } } } });
    say("Here is your boat.");
    done("Here is your boat.");
    return;
  }
  if (prompt.startsWith("route ")) {
    const server = file("mcp.json")?.mcpServers?.shipmate;
    if (!server) { say("No tools."); done("No tools."); return; }
    const auth = server.headers.Authorization.replace(/\\$\\{env:([A-Z_]+)\\}/g, (_, k) => process.env[k] || "");
    const rpc = async (method, params, id) => {
      const res = await fetch(server.url, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
      if (res.status === 202) return null;
      const body = await res.text();
      // Long tool calls come back as a stream with keep-alives, then one data event.
      if ((res.headers.get("content-type") ?? "").includes("event-stream")) return JSON.parse(body.split(String.fromCharCode(10)).find((l) => l.startsWith("data: ")).slice(6));
      return JSON.parse(body);
    };
    (async () => {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cursor-agent", version: "9" } }, 1);
      await rpc("notifications/initialized", {});
      const [, crew, ...task] = prompt.split(" ");
      say("Routing to " + crew + ".");
      const call = { args: { name: "shipmate-delegate", args: { crew, task: task.join(" ") }, toolName: "delegate", providerIdentifier: "shipmate" } };
      out({ type: "tool_call", subtype: "started", call_id: "c2", tool_call: { mcpToolCall: call } });
      const res = await rpc("tools/call", { name: "delegate", arguments: call.args.args }, 3);
      out({ type: "tool_call", subtype: "completed", call_id: "c2", tool_call: { mcpToolCall: { ...call, result: { success: { content: res.result.content, isError: false } } } } });
      say("Wrapped up: " + res.result.content[0].text);
      done("Wrapped up.");
    })();
    return;
  }
  const shell = { args: { command: "cat notes.md", workingDirectory: ws } };
  out({ type: "tool_call", subtype: "started", call_id: "c0", tool_call: { shellToolCall: shell } });
  out({ type: "tool_call", subtype: "completed", call_id: "c0", tool_call: { shellToolCall: { ...shell, result: { success: { stdout: "the notes", stderr: "", exitCode: 0 } } } } });
  say("Done: " + prompt);
  done("Done: " + prompt);
});
`;

const dir = mkdtempSync(join(tmpdir(), "shipmate-fake-cursor-"));
const fakeBin = join(dir, "cursor-agent");
const logFile = join(dir, "calls.jsonl");
writeFileSync(fakeBin, FAKE_CURSOR);
chmodSync(fakeBin, 0o755);

interface Call {
  args: string[];
  cwd: string;
  input: string;
  prompt: string;
  home: string;
  cli: { permissions: { allow: string[]; deny: string[] } } | null;
  sandbox: { readBoundary: string } | null;
  mcp: { mcpServers: Record<string, { url: string; headers: Record<string, string> }> } | null;
  token: boolean;
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

const until = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "shipmate-cursor-data-"));
  const cwd = join(root, "crew", "coder", "cli-workspace");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "crew", "other"));
  mkdirSync(join(root, "files"));
  writeFileSync(join(root, "crew", "coder", "crew.yaml"), "name: Coder\n");
  return { root, cwd };
};

describe("cursor-cli backend: manifest and runner", () => {
  it("accepts the Cursor engine and defaults it to read only", () => {
    const m = CrewManifest.parse({
      name: "Coder",
      role: "code",
      model: "cursor/composer-2.5",
      backend: "cursor-cli",
      cursor: {},
    });
    expect(m.cursor?.mode).toBe("read-only");
    expect(cursorModelFromRef("cursor/composer-2.5")).toBe("composer-2.5");
    expect(cursorModelFromRef("codex/gpt-5.5")).toBeUndefined();
  });

  it("offers a short model list until the CLI names its own", () => {
    expect(cursorModels().map((m) => m.ref)).toEqual(
      CURSOR_FALLBACK_MODELS.map((m) => `cursor/${m.id}`),
    );
    expect(
      parseCursorModels(
        "\x1b[2mAvailable models\x1b[0m\n\nauto - Auto (current)\ngpt-5.5 - GPT-5.5 (default)\nsonnet-4.5-thinking\n\nTip: use --model",
      ),
    ).toEqual([
      { id: "auto", name: "Auto" },
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "sonnet-4.5-thinking", name: "sonnet-4.5-thinking" },
    ]);
  });

  it("runs crew on a Cursor crew default through Cursor", () => {
    const folder = {
      manifest: CrewManifest.parse({ name: "A", role: "r", model: "default" }),
    } as Parameters<typeof onCrewDefault>[0];
    expect(onCrewDefault(folder, "cursor/gpt-5.5").manifest).toMatchObject({
      backend: "cursor-cli",
      model: "cursor/gpt-5.5",
    });
  });

  it("builds a print-mode command line with the prompt on stdin", () => {
    const args = cursorCliArgs({
      cwd: "/data/crew/coder/cli-workspace",
      model: "gpt-5.5",
      mcp: { url: "http://127.0.0.1:3000/api/cli-mcp", token: "secret-token" },
      resume: "chat-1",
    });
    expect(args.slice(0, 6)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--trust",
      "--workspace",
      "/data/crew/coder/cli-workspace",
    ]);
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(args[args.indexOf("--resume") + 1]).toBe("chat-1");
    expect(args).toContain("--approve-mcps");
    // Only "anything" runs every tool unasked.
    expect(args).not.toContain("--force");
    // Print mode writes nothing without --force; edit mode's deny rules still hold.
    expect(cursorCliArgs({ cwd: "/w", settings: { mode: "edit" } })).toContain("--force");
    expect(cursorCliArgs({ cwd: "/w", settings: { mode: "anything" } })).toContain("--force");
    // Neither the token nor the prompt goes on the command line.
    expect(args.join(" ")).not.toContain("secret-token");
    expect(cursorPrompt("hi", "Be brief.")).toBe(
      "<shipmate-instructions>\nBe brief.\n</shipmate-instructions>\n\nhi",
    );
    expect(cursorPrompt("hi")).toBe("hi");
  });

  it("limits reads and writes to the crew member's own folder", () => {
    const { root, cwd } = workspace();
    const ro = cursorPermissions({ cwd, privateRoot: root });
    expect(ro.allow).toEqual(["Read(**)"]);
    expect(ro.deny).toEqual(expect.arrayContaining(["Shell(*)", "Write(**)", "Write(.cursor/**)"]));
    // The rest of Shipmate's data, but not the way down to its folder.
    expect(ro.deny).toContain(`Read(${join(root, "files")}/**)`);
    expect(ro.deny).toContain(`Read(${join(root, "crew", "other")}/**)`);
    expect(ro.deny).toContain(`Read(${join(root, "crew", "coder", "crew.yaml")})`);
    expect(ro.deny.some((d) => d.includes("cli-workspace"))).toBe(false);
    expect(ro.deny.some((d) => d === `Read(${join(root, "crew")}/**)`)).toBe(false);
    const edit = cursorPermissions({ cwd, privateRoot: root, settings: { mode: "edit" } });
    expect(edit.allow).toContain("Write(**)");
    expect(edit.deny).not.toContain("Write(**)");
    expect(edit.deny).toContain("Write(.cursor/**)");
    const any = cursorPermissions({
      cwd,
      privateRoot: root,
      settings: { mode: "anything" },
      mcp: { url: "http://x", token: "t" },
    });
    expect(any).toEqual({ allow: ["Mcp(shipmate:*)"], deny: [] });
    expect(readDenials(cwd, "/elsewhere")).toEqual([]);
  });

  it("writes the same project files for every turn, with the token left to the environment", () => {
    const { root, cwd } = workspace();
    const mcp = { url: "http://127.0.0.1:3000/api/cli-mcp", token: "secret-token" };
    const files = cursorProjectFiles({ cwd, privateRoot: root, mcp });
    expect(files["mcp.json"]).not.toContain("secret-token");
    expect(JSON.parse(files["mcp.json"] ?? "{}")).toEqual({
      mcpServers: {
        shipmate: {
          url: mcp.url,
          headers: { Authorization: `Bearer \${env:CURSOR_SHIPMATE_MCP_TOKEN}` },
        },
      },
    });
    expect(cursorProjectFiles({ cwd, privateRoot: root, mcp: { ...mcp, token: "other" } })).toEqual(
      files,
    );
    expect(JSON.parse(files["sandbox.json"] ?? "{}")).toEqual({ readBoundary: "workspace" });
    expect(cursorProjectFiles({ cwd, settings: { mode: "anything" } })["sandbox.json"]).toBeNull();
  });

  it("streams a run and reports usage", async () => {
    const { root, cwd } = workspace();
    const events: string[] = [];
    const result = await runCursorCli({
      bin: fakeBin,
      home: dir,
      cwd,
      privateRoot: root,
      prompt: "hello",
      instructions: "You are Coder.",
      onEvent: (e) =>
        events.push(
          e.type === "text" ? `text:${e.text}` : `${e.type}:${"name" in e ? e.name : ""}`,
        ),
    });
    expect(result).toMatchObject({
      isError: false,
      text: "Done: hello",
      usage: { input: 120, cacheRead: 80, cacheWrite: 5, output: 14 },
    });
    expect(result.sessionId).toMatch(/^chat-/);
    expect(events).toEqual(["init:", "tool_start:bash", "tool_end:bash", "text:Done: hello"]);
    // The workspace's permission rules were in place before the CLI started.
    expect(existsSync(join(cwd, ".cursor", "cli.json"))).toBe(true);
  });

  it("reports a failed run with the sign-in hint", async () => {
    const { cwd } = workspace();
    const result = await runCursorCli({ bin: fakeBin, home: dir, cwd, prompt: "fail" });
    expect(result.isError).toBe(true);
    expect(result.error).toContain("Authentication required");
    expect(result.error).toContain("cursor-agent login");
  });

  it("starts a fresh chat when the one to resume is gone", async () => {
    const { cwd } = workspace();
    const result = await runCursorCli({
      bin: fakeBin,
      home: dir,
      cwd,
      prompt: "again",
      resume: "gone",
    });
    expect(result.isError).toBe(false);
    expect(result.sessionId).toMatch(/^chat-/);
  });

  it("fails clearly when the binary is missing", async () => {
    const { cwd } = workspace();
    await expect(
      runCursorCli({ bin: join(dir, "missing-cursor"), home: dir, cwd, prompt: "x" }),
    ).rejects.toThrow(/install-cursor/);
    expect((await cursorCliStatus({ bin: join(dir, "missing-cursor") })).installed).toBe(false);
  });

  it("reads the login status and models without opening credentials", async () => {
    expect(await cursorCliStatus({ bin: fakeBin, home: dir, models: true })).toMatchObject({
      installed: true,
      version: "2026.10.12-fake",
      signedIn: true,
      authMethod: "login",
      email: "a@example.com",
      models: [
        { id: "auto", name: "Auto" },
        { id: "composer-2.5", name: "Composer 2.5" },
        { id: "gpt-5.5", name: "GPT-5.5" },
      ],
    });
    expect(
      await cursorCliStatus({
        bin: fakeBin,
        home: dir,
        env: { ...process.env, FAKE_CURSOR_SIGNED_IN: "0" },
      }),
    ).toMatchObject({ signedIn: false, authMethod: null });
    expect(
      await cursorCliStatus({
        bin: fakeBin,
        home: dir,
        env: { ...process.env, CURSOR_API_KEY: "key" },
      }),
    ).toMatchObject({ signedIn: true, authMethod: "api_key" });
  });

  it("collects pictures from the image tool", async () => {
    const { cwd } = workspace();
    const result = await runCursorCli({ bin: fakeBin, home: dir, cwd, prompt: "draw a boat" });
    expect(result.images).toEqual([{ path: join(cwd, "boat.png"), data: null }]);
    const file = await cursorImageFile(result.images[0] as (typeof result.images)[0], cwd, 0);
    expect(file?.name).toBe("boat.png");
    // Only the data, no file: still shown.
    const fromData = await cursorImageFile({ path: "gone.png", data: "aGk=" }, cwd, 1);
    expect(fromData).toEqual({ name: "cursor-image-2.png", data: Buffer.from("hi") });
    // A file outside the workspace is never read, by path or through a link.
    const outside = join(cwd, "..", "secret.png");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(cwd, "link.png"));
    for (const path of [outside, "../secret.png", "link.png"]) {
      expect(await cursorImageFile({ path, data: null }, cwd, 0)).toBeNull();
    }
  });

  it("bills a plan login as subscription and an API key as API spend", () => {
    expect(cursorBilling({})).toBe("subscription");
    expect(cursorBilling({ CURSOR_API_KEY: "key" })).toBe("api");
    // A fresh usage each time: pricing fills in its cost.
    const usage = () => ({
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const model = (id: string) =>
      ({ provider: "cursor", id, cost: zero }) as unknown as Parameters<typeof callCost>[0];
    const plan = callCost(model("gpt-5.5"), usage());
    expect(plan.billing).toBe("subscription");
    expect(plan.costMicroUsd).toBe(0);
    expect(plan.apiEquivalentMicroUsd).toBeGreaterThan(0);
    expect(
      callCost(model("claude-opus-4-8-thinking"), usage()).apiEquivalentMicroUsd,
    ).toBeGreaterThan(0);
    // Cursor's own models have no API price.
    expect(callCost(model("composer-2.5"), usage()).apiEquivalentMicroUsd).toBe(0);
    expect(callCost(model("gpt-5.5"), usage(), "api").costMicroUsd).toBeGreaterThan(0);
  });
});

describe.skipIf(!db)("cursor-cli backend through the Bridge", () => {
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

  const turn = async (conversationId: string, text: string) => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId, text }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    return events;
  };

  let convId = "";
  const home = mkdtempSync(join(tmpdir(), "shipmate-cursor-home-"));

  beforeAll(async () => {
    process.env.SHIPMATE_CURSOR_BIN = fakeBin;
    process.env.SHIPMATE_CURSOR_HOME = home;
    process.env.FAKE_CURSOR_LOG = logFile;
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
      slug: "coder",
      manifestYaml:
        "name: Coder\nrole: code\nmodel: cursor/gpt-5.5\nbackend: cursor-cli\ncursor:\n  mode: edit\n",
      persona: "# Coder\nYou write code.",
    });
    expect(created.statusCode).toBe(200);
    convId = (await api("POST", "/api/conversations", { kind: "direct", crewSlug: "coder" })).json()
      .conversation.id;
  });

  afterAll(async () => {
    delete process.env.SHIPMATE_CURSOR_BIN;
    delete process.env.SHIPMATE_CURSOR_HOME;
    delete process.env.SHIPMATE_TEST_LEAK;
    await sql?.end();
    await t?.app.close();
  });

  it("streams a full Cursor turn into messages and records its usage", async () => {
    const before = calls().length;
    const events = await turn(convId, "fix the bug");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const tools = events.filter((e) => e.type === "tool");
    expect(tools.map((e) => (e.type === "tool" ? `${e.phase}:${e.toolName}` : ""))).toEqual([
      "start:bash",
      "end:bash",
    ]);
    const msgs = (await api("GET", `/api/conversations/${convId}/messages`)).json().messages;
    expect(msgs.at(-1)).toMatchObject({
      role: "assistant",
      content: "Done: fix the bug",
      author: { kind: "crew", slug: "coder" },
    });

    const [usage] = await sql`select * from usage_events where conversation_id = ${convId}`;
    expect(usage).toMatchObject({ model: "cursor/gpt-5.5", billing: "subscription" });
    expect(Number(usage?.cost_micro_usd)).toBe(0);
    expect(Number(usage?.input_tokens)).toBe(120);
    expect(Number(usage?.cache_read_tokens)).toBe(80);

    const call = calls()[before];
    expect(call?.prompt).toBe("fix the bug");
    // The instructions ride in front of the message (no AGENTS.md to race on).
    expect(call?.input).toContain("You write code.");
    expect(call?.cwd).toMatch(/coder[/\\]cli-workspace$/);
    expect(call?.home).toBe(home);
    expect(call?.leaked).toEqual([]);
    const args = call?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(args).not.toContain("--resume");
    expect(args).toContain("--force"); // edit mode: needed to write files
    expect(call?.cli?.permissions.allow).toContain("Write(**)");
    expect(call?.cli?.permissions.deny).toContain("Shell(*)");
    // Other people's files are out of its reach.
    expect(call?.cli?.permissions.deny.some((d) => /[/\\]files[/\\]\*\*\)$/.test(d))).toBe(true);
    expect(call?.sandbox).toEqual({ readBoundary: "workspace" });
  });

  it("bills a Cursor run on an API key as API spend", async () => {
    process.env.CURSOR_API_KEY = "key";
    try {
      const conv = (
        await api("POST", "/api/conversations", { kind: "direct", crewSlug: "coder" })
      ).json().conversation;
      await turn(conv.id, "fix the bug");
      const [usage] = await sql`select * from usage_events where conversation_id = ${conv.id}`;
      expect(usage).toMatchObject({ model: "cursor/gpt-5.5", billing: "api" });
      expect(Number(usage?.cost_micro_usd)).toBeGreaterThan(0);
    } finally {
      delete process.env.CURSOR_API_KEY;
    }
  });

  it("resumes the Cursor chat on the next message", async () => {
    const [conv] = await sql`select session_files from conversations where id = ${convId}`;
    const sid = ((conv?.session_files ?? {}) as Record<string, string>)["cursor-cli:coder"];
    expect(sid).toMatch(/^chat-/);
    const before = calls().length;
    await turn(convId, "and the next one");
    const args = calls()[before]?.args ?? [];
    expect(args[args.indexOf("--resume") + 1]).toBe(sid);
  });

  it("shows pictures Cursor makes on its reply", async () => {
    const events = await turn(convId, "draw a boat");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const reply = (await api("GET", `/api/conversations/${convId}/messages`))
      .json()
      .messages.at(-1);
    expect(reply.content).toBe("Here is your boat.");
    const [file] = reply.meta.attachments;
    expect(file).toMatchObject({ kind: "image", mimeType: "image/png", name: "boat.png" });
    const img = await api("GET", `/api/attachments/${file.id}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toContain("image/png");
  });

  it("shows Cursor errors with the sign-in command", async () => {
    const events = await turn(convId, "fail please");
    const error = events.find((e) => e.type === "error");
    expect(error && "message" in error ? error.message : "").toContain("cursor-agent login");
  });

  it("lets a Captain on Cursor route a message to a crew member", async () => {
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const deck = await api("POST", "/api/crew", {
      slug: "deckhand",
      manifestYaml: "name: Deckhand\nrole: odd jobs\nmodel: faux/m\n",
      persona: "# Deckhand",
    });
    expect(deck.statusCode).toBe(200);
    const detail = (await api("GET", "/api/crew/captain")).json().crew;
    const yaml = `${detail.manifestYaml
      .replace(/^backend:.*\n?/m, "")
      .replace(/^model:.*$/m, "model: cursor/gpt-5.5")
      .trimEnd()}\nbackend: cursor-cli\n`;
    expect((await api("PUT", "/api/crew/captain", { manifestYaml: yaml })).statusCode).toBe(200);
    try {
      const conv = (await api("POST", "/api/conversations", {})).json().conversation;
      t.faux.setResponses([fauxAssistantMessage("Deck swabbed.")]);
      const before = calls().length;
      const events = await turn(conv.id, "route deckhand swab the deck");
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(events.find((e) => e.type === "handoff")).toMatchObject({
        from: { slug: "captain" },
        to: { slug: "deckhand" },
        task: "swab the deck",
      });
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
        ["captain", expect.stringMatching(/^Wrapped up: Deck swabbed\./)],
      ]);
      const call = calls()[before];
      expect(call?.mcp?.mcpServers.shipmate?.url).toMatch(/\/api\/cli-mcp$/);
      expect(call?.token).toBe(true);
      expect(call?.args).toContain("--approve-mcps");
      expect(call?.cli?.permissions.allow).toContain("Mcp(shipmate:*)");
      expect(call?.input).toMatch(/deckhand: Deckhand, odd jobs/);
    } finally {
      await api("PUT", "/api/crew/captain", { manifestYaml: detail.manifestYaml });
    }
  });

  it("reports Cursor status to admins only", async () => {
    const res = await api("GET", "/api/cursor-cli");
    expect(res.statusCode).toBe(200);
    expect(res.json().cursorCli).toMatchObject({
      installed: true,
      version: "2026.10.12-fake",
      signedIn: true,
      authMethod: "login",
      email: "a@example.com",
      configDir: home,
      signInCommand: "docker exec -it shipmate env NO_OPEN_BROWSER=1 cursor-agent login",
      installCommand: "docker exec -it shipmate install-cursor",
    });
    // The signed-in CLI's own list replaces the short default one.
    expect(res.json().cursorCli.models.map((m: { ref: string }) => m.ref)).toEqual([
      "cursor/auto",
      "cursor/composer-2.5",
      "cursor/gpt-5.5",
    ]);
    expect((await api("GET", "/api/cursor-cli", undefined, memberCookie)).statusCode).toBe(403);
  });
});
