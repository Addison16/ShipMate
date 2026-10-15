import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CrewManifest, type ServerEvent } from "@shipmate/core";
import { codexCliArgs, codexCliStatus, runCodexCli } from "@shipmate/crew";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onCrewDefault } from "./claude-cli-turn.js";
import { codexModelFromRef, codexModels, newCodexImages } from "./codex-cli-turn.js";
import { runCodex, setCodexSandboxAvailable } from "./codex-run.js";
import { planModelIds } from "./services/chatgpt.js";
import { callCost } from "./services/usage.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/**
 * A stand-in for the `codex` binary: prints JSONL like `codex exec --json` (event shapes copied
 * from codex-cli 0.162), logs each call to $FAKE_CODEX_LOG. Prompts containing "fail" end in a
 * failed turn; "route <slug> <task>" calls Shipmate's delegate tool over its MCP server.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = (o) => process.env.FAKE_CODEX_LOG && fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (args[0] === "sandbox") {
  if (process.env.FAKE_CODEX_NO_SANDBOX === "1") { console.error("bwrap: No permissions to create a new namespace"); process.exit(1); }
  process.exit(0);
}
if (args[0] === "login") {
  if (process.env.FAKE_CODEX_SIGNED_IN === "0") { console.error("Not logged in"); process.exit(1); }
  console.error(process.env.FAKE_CODEX_API_KEY === "1" ? "Logged in using an API key - sk-***" : "Logged in using ChatGPT");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const configs = {};
  args.forEach((a, i) => { if (a === "-c") { const [k, ...v] = args[i + 1].split("="); const raw = v.join("="); try { configs[k] = JSON.parse(raw); } catch { configs[k] = raw; } } });
  const r = args.indexOf("resume");
  const resume = r >= 0 ? args[r + 1] : undefined;
  log({ args, configs, cwd: process.cwd(), prompt, uid: process.getuid(), home: process.env.HOME, leaked: Object.keys(process.env).filter((k) => k.startsWith("SHIPMATE_")) });
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  if (resume === "gone") { console.error("Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)"); process.exit(1); }
  const tid = resume || "thread-" + Math.random().toString(36).slice(2, 8);
  out({ type: "thread.started", thread_id: tid });
  out({ type: "turn.started" });
  const say = (id, text) => out({ type: "item.completed", item: { id, type: "agent_message", text } });
  const done = () => out({ type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 80, output_tokens: 14, reasoning_output_tokens: 0 } });
  if (prompt.includes("fail")) {
    out({ type: "error", message: "Reconnecting... 1/5" });
    out({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
    process.exit(1);
  }
  if (prompt.startsWith("draw ")) {
    // Like Codex's built-in image tool: the picture lands under CODEX_HOME/generated_images.
    const dir = process.env.CODEX_HOME + "/generated_images/" + tid;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + "/ig_1.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    say("item_0", "Here is your boat.");
    done();
    return;
  }
  const url = configs["mcp_servers.shipmate.url"];
  if (prompt.startsWith("route ")) {
    if (!url) { say("item_0", "No tools."); done(); return; }
    const token = process.env[configs["mcp_servers.shipmate.bearer_token_env_var"]];
    const rpc = async (method, params, id) => {
      const res = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
      if (res.status === 202) return null;
      const body = await res.text();
      // Long tool calls come back as a stream with keep-alives, then one data event.
      if ((res.headers.get("content-type") ?? "").includes("event-stream")) return JSON.parse(body.split(String.fromCharCode(10)).find((l) => l.startsWith("data: ")).slice(6));
      return JSON.parse(body);
    };
    (async () => {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "9" } }, 1);
      await rpc("notifications/initialized", {});
      const [, crew, ...task] = prompt.trim().split(" ");
      say("item_0", "Routing to " + crew + ".");
      const item = { id: "item_1", type: "mcp_tool_call", server: "shipmate", tool: "delegate", arguments: { crew, task: task.join(" ") }, result: null, error: null, status: "in_progress" };
      out({ type: "item.started", item });
      const res = await rpc("tools/call", { name: "delegate", arguments: item.arguments }, 3);
      out({ type: "item.completed", item: { ...item, result: { content: res.result.content }, status: "completed" } });
      say("item_2", "Wrapped up: " + res.result.content[0].text);
      done();
    })();
    return;
  }
  out({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "cat notes.md", aggregated_output: "", exit_code: null, status: "in_progress" } });
  out({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "cat notes.md", aggregated_output: "the notes", exit_code: 0, status: "completed" } });
  say("item_1", "Done: " + prompt.trim());
  done();
});
`;

const dir = mkdtempSync(join(tmpdir(), "shipmate-fake-codex-"));
const fakeBin = join(dir, "codex");
const logFile = join(dir, "calls.jsonl");
writeFileSync(fakeBin, FAKE_CODEX);
chmodSync(fakeBin, 0o755);

interface Call {
  args: string[];
  configs: Record<string, string>;
  cwd: string;
  prompt: string;
  uid: number;
  home: string;
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

describe("codex-cli backend: manifest and runner", () => {
  it("accepts the Codex engine and defaults its sandbox to read-only", () => {
    const m = CrewManifest.parse({
      name: "Coder",
      role: "code",
      model: "codex/gpt-6.1-sol",
      backend: "codex-cli",
      codex: {},
    });
    expect(m.codex?.sandbox).toBe("read-only");
    expect(codexModelFromRef("codex/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(codexModelFromRef("chatgpt/gpt-6.1-sol")).toBeUndefined();
  });

  it("offers the ChatGPT plan's models, newest first", () => {
    const models = codexModels();
    expect(models.map((m) => m.ref)).toEqual(planModelIds().map((id) => `codex/${id}`));
    expect(models.some((m) => m.ref === "codex/gpt-4")).toBe(false);
    expect(models[0]?.name).not.toBe(models[0]?.ref);
  });

  it("runs crew on a Codex crew default through Codex", () => {
    const folder = {
      manifest: CrewManifest.parse({ name: "A", role: "r", model: "default" }),
    } as Parameters<typeof onCrewDefault>[0];
    expect(onCrewDefault(folder, "codex/gpt-6.1-sol").manifest).toMatchObject({
      backend: "codex-cli",
      model: "codex/gpt-6.1-sol",
    });
  });

  it("builds an exec command line with the prompt on stdin", () => {
    const args = codexCliArgs({
      cwd: "/data/crew/coder/cli-workspace",
      model: "gpt-6.1-sol",
      instructions: 'Be "brief".\nThanks',
      mcp: { url: "http://127.0.0.1:3000/api/cli-mcp", token: "secret-token" },
      resume: "thread-1",
    });
    expect(args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    // Not Codex's plain read-only sandbox, which can read all of /data: only its own folder.
    expect(args).not.toContain("--sandbox");
    expect(args).toContain('default_permissions="shipmate"');
    const profile = args.find((a) => a.startsWith("permissions.shipmate.filesystem="));
    expect(profile).toContain('":minimal"="read"');
    expect(profile).toContain('"/data/crew/coder/cli-workspace"="read"');
    expect(profile).not.toContain('"/data"');
    const write = codexCliArgs({ cwd: "/w", settings: { sandbox: "workspace-write" } });
    expect(write.find((a) => a.startsWith("permissions."))).toContain('"/w"="write"');
    const full = codexCliArgs({ cwd: "/w", settings: { sandbox: "danger-full-access" } });
    expect(full.slice(3, 5)).toEqual(["--sandbox", "danger-full-access"]);
    expect(full.join(" ")).not.toContain("permissions.");
    // Where Codex's sandbox can't start, Shipmate turns it off and isolates the run itself.
    const bare = codexCliArgs({ cwd: "/w", settings: { sandbox: "read-only" }, unsandboxed: true });
    expect(bare.slice(3, 5)).toEqual(["--sandbox", "danger-full-access"]);
    expect(bare.join(" ")).not.toContain("permissions.");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
    expect(args).toContain('developer_instructions="Be \\"brief\\".\\nThanks"');
    // The token itself never goes on the command line.
    expect(args.join(" ")).not.toContain("secret-token");
    expect(args).toContain('mcp_servers.shipmate.bearer_token_env_var="CODEX_SHIPMATE_MCP_TOKEN"');
    expect(args.slice(-3)).toEqual(["resume", "thread-1", "-"]);
  });

  it("streams a run and reports usage", async () => {
    const events: string[] = [];
    const result = await runCodexCli({
      bin: fakeBin,
      cwd: dir,
      prompt: "hello",
      onEvent: (e) =>
        events.push(
          e.type === "text" ? `text:${e.text}` : `${e.type}:${"name" in e ? e.name : ""}`,
        ),
    });
    expect(result).toMatchObject({
      isError: false,
      text: "Done: hello",
      // Cached input is counted apart from fresh input.
      usage: { input: 120, cacheRead: 80, output: 14 },
    });
    expect(result.sessionId).toMatch(/^thread-/);
    expect(events).toEqual(["init:", "tool_start:bash", "tool_end:bash", "text:Done: hello"]);
  });

  it("reports a failed turn with the sign-in hint", async () => {
    const result = await runCodexCli({ bin: fakeBin, cwd: dir, prompt: "fail" });
    expect(result.isError).toBe(true);
    expect(result.error).toContain("401 Unauthorized");
    expect(result.error).toContain("codex login --device-auth");
  });

  it("starts a fresh thread when the one to resume is gone", async () => {
    const result = await runCodexCli({ bin: fakeBin, cwd: dir, prompt: "again", resume: "gone" });
    expect(result.isError).toBe(false);
    expect(result.sessionId).toMatch(/^thread-/);
  });

  it("fails clearly when the binary is missing", async () => {
    await expect(
      runCodexCli({ bin: join(dir, "missing-codex"), cwd: dir, prompt: "x" }),
    ).rejects.toThrow(/not installed/);
  });

  it("reads the login status without opening credentials", async () => {
    expect(await codexCliStatus({ bin: fakeBin })).toMatchObject({
      installed: true,
      version: "9.9.9",
      signedIn: true,
      authMethod: "chatgpt",
    });
    expect(
      await codexCliStatus({ bin: fakeBin, env: { ...process.env, FAKE_CODEX_SIGNED_IN: "0" } }),
    ).toMatchObject({ signedIn: false, authMethod: null });
  });

  it("finds only this turn's pictures", async () => {
    const root = mkdtempSync(join(tmpdir(), "shipmate-codex-home-"));
    const at = (p: string) => {
      mkdirSync(join(root, "generated_images", p, ".."), { recursive: true });
      writeFileSync(join(root, "generated_images", p), "png");
    };
    const since = Date.now() - 1000;
    at("thread-a/one.png");
    at("thread-b/two.png");
    const base = { root, since, named: [] as string[] };
    expect(await newCodexImages({ ...base, threadId: "thread-a", alone: false })).toEqual([
      join(root, "generated_images", "thread-a", "one.png"),
    ]);
    // Not named by thread: only when no other Codex turn ran alongside.
    expect(await newCodexImages({ ...base, threadId: "thread-c", alone: false })).toEqual([]);
    expect(await newCodexImages({ ...base, threadId: "thread-c", alone: true })).toHaveLength(2);
    // Older pictures never come back.
    expect(
      await newCodexImages({ ...base, since: Date.now() + 60_000, threadId: "x", alone: true }),
    ).toEqual([]);
    expect(
      await newCodexImages({ ...base, threadId: null, alone: false, named: ["/a.png"] }),
    ).toEqual(["/a.png"]);
  });

  it("prices Codex calls at API rates without counting them as spend", () => {
    const usage = {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_000_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const model = {
      provider: "codex",
      id: planModelIds()[0],
      cost: usage.cost,
    } as unknown as Parameters<typeof callCost>[0];
    const c = callCost(model, usage);
    expect(c.billing).toBe("subscription");
    expect(c.costMicroUsd).toBe(0);
    expect(c.apiEquivalentMicroUsd).toBeGreaterThan(0);
  });
});

describe("codex-cli backend where Docker blocks Codex's sandbox", () => {
  const root = process.getuid?.() === 0;
  const env = { ...process.env };
  afterAll(() => {
    process.env = env;
    setCodexSandboxAvailable(undefined);
  });

  it("runs Codex without its sandbox, as the CLI user, keeping it out of private folders", async () => {
    const data = join(dir, "data");
    const home = join(data, "codex");
    const work = join(data, "crew", "painter", "cli-workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(join(data, "pi"), { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    // The CLI user must reach the fake binary and its log, as it reaches /usr/local in the image.
    chmodSync(dir, 0o777);
    process.env.SHIPMATE_CODEX_BIN = fakeBin;
    process.env.FAKE_CODEX_LOG = logFile;
    process.env.FAKE_CODEX_NO_SANDBOX = "1";
    process.env.CODEX_HOME = home;
    process.env.SHIPMATE_DATA_DIR = data;
    process.env.SHIPMATE_CLI_UID = "1500";
    process.env.SHIPMATE_CLI_GID = "1500";
    setCodexSandboxAvailable(undefined);

    const before = calls().length;
    const result = await runCodex(
      { cwd: work, prompt: "hello", settings: { sandbox: "read-only" } },
      false,
    );
    expect(result.isError).toBe(false);
    const call = calls()[before];
    expect(call?.args.slice(3, 5)).toEqual(["--sandbox", "danger-full-access"]);
    expect(call?.args.join(" ")).not.toContain("permissions.");
    if (!root) return;
    expect(call).toMatchObject({ uid: 1500, home });
    expect(statSync(join(home, "auth.json")).uid).toBe(1500);
    // Read-only: the crew folder stays root's; a crew member that may edit gets it.
    expect(statSync(work).uid).toBe(0);
    expect(statSync(join(data, "pi")).mode & 0o077).toBe(0);
    await runCodex({ cwd: work, prompt: "hello", settings: { sandbox: "workspace-write" } }, true);
    expect(statSync(work).uid).toBe(1500);
    await runCodex({ cwd: work, prompt: "hello", settings: { sandbox: "read-only" } }, false);
    expect(statSync(work).uid).toBe(0);
  });

  it("keeps Codex's own sandbox where it works", async () => {
    process.env.SHIPMATE_CODEX_BIN = fakeBin;
    process.env.FAKE_CODEX_LOG = logFile;
    delete process.env.FAKE_CODEX_NO_SANDBOX;
    setCodexSandboxAvailable(undefined);
    const before = calls().length;
    await runCodex({ cwd: dir, prompt: "hello", settings: { sandbox: "read-only" } }, false);
    const call = calls()[before];
    expect(call?.args.join(" ")).toContain("default_permissions");
    expect(call?.uid).toBe(process.getuid?.());
  });
});

describe.skipIf(!db)("codex-cli backend through the Bridge", () => {
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

  beforeAll(async () => {
    process.env.SHIPMATE_CODEX_BIN = fakeBin;
    process.env.FAKE_CODEX_LOG = logFile;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "shipmate-codex-home-"));
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
        "name: Coder\nrole: code\nmodel: codex/gpt-6.1-sol\nbackend: codex-cli\ncodex:\n  sandbox: workspace-write\n",
      persona: "# Coder\nYou write code.",
    });
    expect(created.statusCode).toBe(200);
    convId = (await api("POST", "/api/conversations", { kind: "direct", crewSlug: "coder" })).json()
      .conversation.id;
  });

  afterAll(async () => {
    delete process.env.SHIPMATE_CODEX_BIN;
    delete process.env.SHIPMATE_TEST_LEAK;
    delete process.env.CODEX_HOME;
    await sql?.end();
    await t?.app.close();
  });

  it("streams a full Codex turn into messages and records its usage", async () => {
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
    expect(usage).toMatchObject({ model: "codex/gpt-6.1-sol", billing: "subscription" });
    expect(Number(usage?.cost_micro_usd)).toBe(0);
    expect(Number(usage?.input_tokens)).toBe(120);
    expect(Number(usage?.cache_read_tokens)).toBe(80);

    const call = calls()[before];
    expect(call?.prompt).toBe("fix the bug");
    expect(call?.cwd).toMatch(/coder[/\\]cli-workspace$/);
    expect(call?.leaked).toEqual([]);
    const args = call?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
    expect(args.find((a) => a.startsWith("permissions.shipmate."))).toMatch(
      /cli-workspace"="write"/,
    );
    expect(call?.configs.developer_instructions).toContain("You write code.");
    expect(args).not.toContain("resume");
  });

  it("bills a Codex run signed in with an API key as API spend", async () => {
    process.env.FAKE_CODEX_API_KEY = "1";
    try {
      const conv = (
        await api("POST", "/api/conversations", { kind: "direct", crewSlug: "coder" })
      ).json().conversation;
      await turn(conv.id, "fix the bug");
      const [usage] = await sql`select * from usage_events where conversation_id = ${conv.id}`;
      expect(usage).toMatchObject({ model: "codex/gpt-6.1-sol", billing: "api" });
      expect(Number(usage?.cost_micro_usd)).toBeGreaterThan(0);
    } finally {
      delete process.env.FAKE_CODEX_API_KEY;
    }
  });

  it("resumes the Codex thread on the next message", async () => {
    const [conv] = await sql`select session_files from conversations where id = ${convId}`;
    const tid = ((conv?.session_files ?? {}) as Record<string, string>)["codex-cli:coder"];
    expect(tid).toMatch(/^thread-/);
    const before = calls().length;
    await turn(convId, "and the next one");
    const args = calls()[before]?.args ?? [];
    expect(args.slice(-3)).toEqual(["resume", tid, "-"]);
  });

  it("shows pictures Codex makes on its reply", async () => {
    const events = await turn(convId, "draw a boat");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const reply = (await api("GET", `/api/conversations/${convId}/messages`))
      .json()
      .messages.at(-1);
    expect(reply.content).toBe("Here is your boat.");
    const [file] = reply.meta.attachments;
    expect(file).toMatchObject({ kind: "image", mimeType: "image/png", name: "ig_1.png" });
    const img = await api("GET", `/api/attachments/${file.id}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toContain("image/png");
  });

  it("shows Codex errors with the sign-in command", async () => {
    const events = await turn(convId, "fail please");
    const error = events.find((e) => e.type === "error");
    expect(error && "message" in error ? error.message : "").toContain("codex login");
  });

  it("lets a Captain on Codex route a message to a crew member", async () => {
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
      .replace(/^model:.*$/m, "model: codex/gpt-6.1-sol")
      .trimEnd()}\nbackend: codex-cli\n`;
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
      expect(call?.configs["mcp_servers.shipmate.url"]).toMatch(/\/api\/cli-mcp$/);
      expect(call?.configs.developer_instructions).toMatch(/deckhand: Deckhand, odd jobs/);
    } finally {
      await api("PUT", "/api/crew/captain", { manifestYaml: detail.manifestYaml });
    }
  });

  it("reports Codex status to admins only", async () => {
    const res = await api("GET", "/api/codex-cli");
    expect(res.statusCode).toBe(200);
    expect(res.json().codexCli).toMatchObject({
      installed: true,
      version: "9.9.9",
      signedIn: true,
      authMethod: "chatgpt",
      signInCommand: "docker exec -it shipmate codex login --device-auth",
    });
    expect(res.json().codexCli.models[0].ref).toBe(`codex/${planModelIds()[0]}`);
    expect((await api("GET", "/api/codex-cli", undefined, memberCookie)).statusCode).toBe(403);
  });
});
