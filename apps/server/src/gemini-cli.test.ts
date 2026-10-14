import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CrewManifest, type ServerEvent } from "@shipmate/core";
import {
  GEMINI_MODELS,
  geminiApprovalMode,
  geminiCliArgs,
  geminiCliStatus,
  geminiPolicy,
  geminiProjectFiles,
  geminiPrompt,
  runGeminiCli,
} from "@shipmate/crew";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onCrewDefault } from "./claude-cli-turn.js";
import { geminiBilling, geminiModelFromRef, geminiModels } from "./gemini-cli-turn.js";
import { callCost } from "./services/usage.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/**
 * A stand-in for the `gemini` binary: prints JSON lines like `gemini -p "" -o stream-json` (event
 * shapes from @google/gemini-cli 0.64.0) and logs each call to $FAKE_GEMINI_LOG. Prompts
 * containing "fail" end like a CLI with no way to sign in (exit 41); "quota" like a failed API
 * call; "hang" never ends; "route <slug> <task>" calls Shipmate's delegate tool over the MCP
 * server named in the workspace's .gemini/settings.json.
 */
const FAKE_GEMINI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = (o) => process.env.FAKE_GEMINI_LOG && fs.appendFileSync(process.env.FAKE_GEMINI_LOG, JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("0.64.0-fake"); process.exit(0); }
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
  const settings = JSON.parse(read(path.join(process.cwd(), ".gemini", "settings.json")) || "null");
  const policyPath = arg("--policy");
  // The CLI puts stdin in front of the -p text.
  const text = input + (arg("-p") ? "\\n\\n" + arg("-p") : "");
  const prompt = text.split("</shipmate-instructions>\\n\\n").pop().trim();
  const resume = arg("--resume");
  log({ args, cwd: process.cwd(), input, prompt, home: process.env.GEMINI_CLI_HOME, trust: process.env.GEMINI_CLI_TRUST_WORKSPACE, auth: process.env.GEMINI_CLI_AUTH_OVERRIDE || null, apiKey: process.env.GEMINI_API_KEY || null, settings, policy: policyPath ? read(policyPath) : null, token: !!process.env.GEMINI_SHIPMATE_MCP_TOKEN, leaked: Object.keys(process.env).filter((k) => k.startsWith("SHIPMATE_")) });
  if (resume === "gone") { console.error('Error resuming session: Invalid session identifier "gone".'); process.exit(42); }
  if (prompt.includes("fail")) { console.error("Please set an Auth method in your " + process.env.GEMINI_CLI_HOME + "/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA"); process.exit(41); }
  if (prompt.includes("hang")) { setInterval(() => {}, 1000); return; }
  const sid = resume || "1c0ffee0-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
  const now = () => new Date().toISOString();
  const out = (o) => process.stdout.write(JSON.stringify({ timestamp: now(), ...o }) + "\\n");
  const say = (t) => out({ type: "message", role: "assistant", content: t, delta: true });
  const stats = (n) => ({ total_tokens: 150 * n, input_tokens: 120 * n, output_tokens: 30 * n, cached: 80 * n, input: 40 * n, duration_ms: 5, tool_calls: 1, models: { "gemini-2.5-flash": { total_tokens: 150 * n, input_tokens: 120 * n, output_tokens: 30 * n, cached: 80 * n, input: 40 * n } } });
  const done = () => out({ type: "result", status: "success", stats: stats(1) });
  out({ type: "init", session_id: sid, model: arg("-m") || "auto-gemini-3" });
  out({ type: "message", role: "user", content: text });
  if (prompt.includes("quota")) {
    out({ type: "error", severity: "warning", message: "Retrying after 429" });
    out({ type: "result", status: "error", error: { type: "unknown", message: "[API Error: You exceeded your current quota]" }, stats: stats(0) });
    process.exit(1);
  }
  if (prompt.startsWith("route ")) {
    const server = settings && settings.mcpServers && settings.mcpServers.shipmate;
    if (!server || arg("--allowed-mcp-server-names") !== "shipmate") { say("No tools."); done(); return; }
    const auth = server.headers.Authorization.replace(/\\$\\{([A-Z_]+)\\}/g, (_, k) => process.env[k] || "");
    const rpc = async (method, params, id) => {
      const res = await fetch(server.httpUrl, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
      if (res.status === 202) return null;
      const body = await res.text();
      // Long tool calls come back as a stream with keep-alives, then one data event.
      if ((res.headers.get("content-type") ?? "").includes("event-stream")) return JSON.parse(body.split(String.fromCharCode(10)).find((l) => l.startsWith("data: ")).slice(6));
      return JSON.parse(body);
    };
    (async () => {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gemini-cli-mcp-client", version: "9" } }, 1);
      await rpc("notifications/initialized", {});
      const [, crew, ...task] = prompt.split(" ");
      say("Routing to " + crew + ".");
      const id = "mcp_shipmate_delegate__mcp_shipmate_delegate_1_0";
      out({ type: "tool_use", tool_name: "mcp_shipmate_delegate", tool_id: id, parameters: { crew, task: task.join(" ") } });
      const res = await rpc("tools/call", { name: "delegate", arguments: { crew, task: task.join(" ") } }, 3);
      out({ type: "tool_result", tool_id: id, status: "success", output: res.result.content[0].text });
      say("Wrapped up: ");
      say(res.result.content[0].text);
      done();
    })();
    return;
  }
  const id = "read_file__read_file_1_0";
  if (prompt.startsWith("look")) say("Let me look.");
  out({ type: "tool_use", tool_name: "read_file", tool_id: id, parameters: { file_path: "notes.md" } });
  out({ type: "tool_result", tool_id: id, status: "success", output: "" });
  say("Done: ");
  say(prompt);
  done();
});
`;

const dir = mkdtempSync(join(tmpdir(), "shipmate-fake-gemini-"));
const fakeBin = join(dir, "gemini");
const logFile = join(dir, "calls.jsonl");
writeFileSync(fakeBin, FAKE_GEMINI);
chmodSync(fakeBin, 0o755);
process.env.FAKE_GEMINI_LOG = logFile;

interface Call {
  args: string[];
  cwd: string;
  input: string;
  prompt: string;
  home: string;
  trust: string;
  auth: string | null;
  apiKey: string | null;
  settings: {
    mcpServers: Record<
      string,
      { httpUrl: string; headers: Record<string, string>; trust: boolean }
    >;
  } | null;
  policy: string | null;
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
  const root = mkdtempSync(join(tmpdir(), "shipmate-gemini-data-"));
  const cwd = join(root, "crew", "coder", "cli-workspace");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
};

/** A Gemini home with a Google login on file (Shipmate never reads its content). */
const loginHome = () => {
  const home = mkdtempSync(join(tmpdir(), "shipmate-gemini-home-"));
  mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".gemini", "oauth_creds.json"), '{"refresh_token":"not-read"}');
  writeFileSync(join(home, ".gemini", "google_accounts.json"), '{"active":"a@example.com"}');
  return home;
};
const emptyHome = () => mkdtempSync(join(tmpdir(), "shipmate-gemini-home-"));
/** An environment without a GEMINI_API_KEY of the machine running the tests. */
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const { GEMINI_API_KEY: _drop, ...rest } = process.env;
  return { ...rest, ...extra };
};

/** The policy's argsPattern rules, as regexes, by tool. */
const patterns = (policy: string) =>
  policy
    .split("[[rule]]")
    .slice(1)
    .map((r) => ({
      tools: JSON.parse(/toolName = (.*)/.exec(r)?.[1] ?? "null") as string | string[],
      pattern: /argsPattern = (.*)/.exec(r)?.[1],
    }))
    .filter((r) => r.pattern)
    .map((r) => ({ tools: [r.tools].flat(), re: new RegExp(JSON.parse(r.pattern as string)) }));
const denied = (policy: string, tool: string, params: unknown) =>
  patterns(policy).some((r) => r.tools.includes(tool) && r.re.test(JSON.stringify(params)));

describe("gemini-cli backend: manifest and runner", () => {
  it("accepts the Gemini CLI engine and defaults it to read only", () => {
    const m = CrewManifest.parse({
      name: "Coder",
      role: "code",
      model: "gemini-cli/flash",
      backend: "gemini-cli",
      gemini: {},
    });
    expect(m.gemini?.mode).toBe("read-only");
    expect(geminiModelFromRef("gemini-cli/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    // pi's own Google provider is not the CLI.
    expect(geminiModelFromRef("google/gemini-2.5-pro")).toBeUndefined();
    expect(geminiModels().map((m) => m.ref)).toEqual(
      GEMINI_MODELS.map((m) => `gemini-cli/${m.id}`),
    );
    expect(geminiModels().map((m) => m.ref)).toEqual(
      expect.arrayContaining([
        "gemini-cli/auto",
        "gemini-cli/flash-lite",
        "gemini-cli/gemini-2.5-pro",
      ]),
    );
  });

  it("runs crew on a Gemini CLI crew default through the Gemini CLI", () => {
    const folder = {
      manifest: CrewManifest.parse({ name: "A", role: "r", model: "default" }),
    } as Parameters<typeof onCrewDefault>[0];
    expect(onCrewDefault(folder, "gemini-cli/flash").manifest).toMatchObject({
      backend: "gemini-cli",
      model: "gemini-cli/flash",
    });
  });

  it("builds a headless command line with the prompt on stdin", () => {
    const cwd = "/data/crew/coder/cli-workspace";
    const args = geminiCliArgs({
      cwd,
      model: "flash",
      mcp: { url: "http://127.0.0.1:3000/api/cli-mcp", token: "secret-token" },
      resume: "1c0ffee0-0000-4000-8000-000000000001",
    });
    expect(args.slice(0, 5)).toEqual(["-p", "", "-o", "stream-json", "--skip-trust"]);
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("default");
    expect(args[args.indexOf("--allowed-mcp-server-names") + 1]).toBe("shipmate");
    expect(args[args.indexOf("--policy") + 1]).toBe(`${cwd}/.gemini/shipmate-policy.toml`);
    expect(args[args.indexOf("-m") + 1]).toBe("flash");
    expect(args[args.indexOf("--resume") + 1]).toBe("1c0ffee0-0000-4000-8000-000000000001");
    // Neither the token nor the prompt goes on the command line.
    expect(args.join(" ")).not.toContain("secret-token");
    expect(geminiApprovalMode({ mode: "edit" })).toBe("auto_edit");
    expect(geminiApprovalMode({ mode: "anything" })).toBe("yolo");
    const any = geminiCliArgs({ cwd, settings: { mode: "anything" } });
    expect(any).not.toContain("--policy");
    expect(any).not.toContain("-m");
    // Without Shipmate's tools, no MCP server at all.
    expect(any[any.indexOf("--allowed-mcp-server-names") + 1]).toBe("none");
    expect(geminiPrompt("hi", "Be brief.")).toBe(
      "<shipmate-instructions>\nBe brief.\n</shipmate-instructions>\n\nhi",
    );
    expect(geminiPrompt("hi")).toBe("hi");
  });

  it("keeps reads and writes to the crew member's own folder", () => {
    const cwd = "/data/crew/coder/cli-workspace";
    const ro = geminiPolicy({ cwd }) ?? "";
    // Its own folder, by relative or absolute path.
    expect(denied(ro, "read_file", { file_path: "notes.md" })).toBe(false);
    expect(denied(ro, "read_file", { file_path: `${cwd}/notes.md` })).toBe(false);
    expect(denied(ro, "list_directory", { dir_path: cwd })).toBe(false);
    expect(denied(ro, "glob", { pattern: "**/*.md" })).toBe(false);
    expect(denied(ro, "grep_search", { pattern: "a/../b", dir_path: "." })).toBe(false);
    // The CLI's own folder for this workspace holds every person's transcripts.
    expect(denied(ro, "read_file", { file_path: "/data/gemini/.gemini/tmp/cli-workspace/x" })).toBe(
      true,
    );
    expect(denied(ro, "read_file", { file_path: "../../../gemini/.gemini/tmp/x" })).toBe(true);
    expect(denied(ro, "read_file", { file_path: `${cwd}/../crew.yaml` })).toBe(true);
    expect(denied(ro, "read_file", { file_path: `${cwd}-other/x` })).toBe(true);
    expect(denied(ro, "read_file", { file_path: "~/.gemini/oauth_creds.json" })).toBe(true);
    expect(denied(ro, "glob", { pattern: "/data/gemini/**" })).toBe(true);
    expect(denied(ro, "grep_search", { pattern: "x", dir_path: "/data" })).toBe(true);
    expect(denied(ro, "read_many_files", { include: ["a.md", "/data/gemini/x"] })).toBe(true);
    expect(denied(ro, "read_many_files", { include: ["a.md", "b.md"] })).toBe(false);
    // Read only: no edits and no shell at all.
    expect(ro).toMatch(/toolName = \["write_file", "replace"\]\ndecision = "deny"/);
    expect(ro).toMatch(/toolName = "run_shell_command"\ndecision = "deny"/);

    const edit = geminiPolicy({ cwd, settings: { mode: "edit" } }) ?? "";
    expect(edit).not.toMatch(/toolName = \["write_file", "replace"\]\ndecision = "deny"/);
    expect(edit).toMatch(/toolName = "run_shell_command"\ndecision = "deny"/);
    expect(denied(edit, "write_file", { file_path: "a.md", content: "x .. y /etc" })).toBe(false);
    // Not its own settings, nor the CLI's global memory file.
    expect(denied(edit, "write_file", { file_path: ".gemini/settings.json", content: "{}" })).toBe(
      true,
    );
    expect(denied(edit, "replace", { file_path: `${cwd}/.gemini/shipmate-policy.toml` })).toBe(
      true,
    );
    expect(denied(edit, "write_file", { file_path: "/data/gemini/.gemini/GEMINI.md" })).toBe(true);
    expect(geminiPolicy({ cwd, settings: { mode: "anything" } })).toBeNull();
  });

  it("writes the same project files for every turn, with the token left to the environment", () => {
    const { cwd } = workspace();
    const mcp = { url: "http://127.0.0.1:3000/api/cli-mcp", token: "secret-token" };
    const files = geminiProjectFiles({ cwd, mcp });
    expect(files["settings.json"]).not.toContain("secret-token");
    expect(JSON.parse(files["settings.json"] ?? "{}")).toEqual({
      mcpServers: {
        shipmate: {
          httpUrl: mcp.url,
          headers: { Authorization: `Bearer \${GEMINI_SHIPMATE_MCP_TOKEN}` },
          trust: true,
        },
      },
    });
    expect(geminiProjectFiles({ cwd, mcp: { ...mcp, token: "other" } })).toEqual(files);
    expect(files["shipmate-policy.toml"]).toContain("run_shell_command");
    expect(geminiProjectFiles({ cwd, settings: { mode: "anything" } })).toEqual({
      "settings.json": null,
      "shipmate-policy.toml": null,
    });
  });

  it("streams a run and reports usage per model", async () => {
    const { cwd } = workspace();
    const events: string[] = [];
    const result = await runGeminiCli({
      bin: fakeBin,
      home: loginHome(),
      env: env(),
      cwd,
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
      usage: { input: 40, cacheRead: 80, output: 30 },
      models: [{ id: "gemini-2.5-flash", usage: { input: 40, cacheRead: 80, output: 30 } }],
    });
    expect(result.sessionId).toMatch(/^1c0ffee0-/);
    expect(events).toEqual([
      "init:",
      "tool_start:read",
      "tool_end:read",
      "text:Done: ",
      "text:hello",
    ]);
    // The workspace's files were in place before the CLI started.
    expect(existsSync(join(cwd, ".gemini", "shipmate-policy.toml"))).toBe(true);
    const call = calls().at(-1);
    expect(call?.policy).toContain("Only files in your own folder.");
    expect(call?.trust).toBe("true");
    // A Google login: the CLI is told to use it.
    expect(call).toMatchObject({ auth: "oauth-personal", apiKey: null });
  });

  it("starts a new paragraph after a tool call", async () => {
    const { cwd } = workspace();
    const result = await runGeminiCli({
      bin: fakeBin,
      home: loginHome(),
      env: env(),
      cwd,
      prompt: "look around",
    });
    expect(result.text).toBe("Let me look.\n\nDone: look around");
  });

  it("uses an API key ahead of a login, in the environment only", async () => {
    const { cwd } = workspace();
    await runGeminiCli({
      bin: fakeBin,
      home: loginHome(),
      env: env(),
      cwd,
      prompt: "hello",
      apiKey: "AIza-test",
    });
    const call = calls().at(-1);
    expect(call).toMatchObject({ auth: "gemini-api-key", apiKey: "AIza-test" });
    expect(call?.args.join(" ")).not.toContain("AIza-test");
  });

  it("reports a run with no sign-in with the setup hint", async () => {
    const { cwd } = workspace();
    const result = await runGeminiCli({
      bin: fakeBin,
      home: emptyHome(),
      env: env(),
      cwd,
      prompt: "fail",
    });
    expect(result.isError).toBe(true);
    expect(calls().at(-1)?.auth).toBeNull();
    expect(result.error).toContain("Please set an Auth method");
    expect(result.error).toContain("NO_BROWSER=true gemini");
    expect(result.error).toContain("Google AI Pro plans don't work with Gemini CLI");
  });

  it("reports a failed API call from the result line", async () => {
    const { cwd } = workspace();
    const result = await runGeminiCli({
      bin: fakeBin,
      home: loginHome(),
      env: env(),
      cwd,
      prompt: "quota",
    });
    expect(result.isError).toBe(true);
    expect(result.error).toBe("[API Error: You exceeded your current quota]");
  });

  it("starts a fresh session when the one to resume is gone", async () => {
    const { cwd } = workspace();
    const result = await runGeminiCli({
      bin: fakeBin,
      home: loginHome(),
      env: env(),
      cwd,
      prompt: "again",
      resume: "gone",
    });
    expect(result.isError).toBe(false);
    expect(result.sessionId).toMatch(/^1c0ffee0-/);
  });

  it("stops a turn that takes too long", async () => {
    const { cwd } = workspace();
    const result = await runGeminiCli({
      bin: fakeBin,
      home: loginHome(),
      env: env(),
      cwd,
      prompt: "hang",
      timeoutMs: 300,
    });
    expect(result).toMatchObject({ isError: true, timedOut: true, aborted: false });
    expect(result.error).toContain("did not finish");
  });

  it("fails clearly when the binary is missing", async () => {
    const { cwd } = workspace();
    await expect(
      runGeminiCli({ bin: join(dir, "missing-gemini"), home: dir, cwd, prompt: "x" }),
    ).rejects.toThrow(/npm install -g @google\/gemini-cli/);
    expect((await geminiCliStatus({ bin: join(dir, "missing-gemini") })).installed).toBe(false);
  });

  it("reads the version and how it signs in without opening the login", async () => {
    expect(await geminiCliStatus({ bin: fakeBin, home: loginHome(), env: env() })).toMatchObject({
      installed: true,
      version: "0.64.0-fake",
      signedIn: true,
      authMethod: "login",
      email: "a@example.com",
      keyInEnv: false,
    });
    const home = emptyHome();
    expect(await geminiCliStatus({ bin: fakeBin, home, env: env() })).toMatchObject({
      signedIn: false,
      authMethod: null,
    });
    expect(await geminiCliStatus({ bin: fakeBin, home, env: env(), apiKey: "k" })).toMatchObject({
      signedIn: true,
      authMethod: "api_key",
      keyInEnv: false,
    });
    expect(
      await geminiCliStatus({ bin: fakeBin, home, env: env({ GEMINI_API_KEY: "k" }) }),
    ).toMatchObject({ signedIn: true, authMethod: "api_key", keyInEnv: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("bills an API key as API spend and a work login as its plan", () => {
    expect(geminiBilling("key", {}, emptyHome())).toBe("api");
    expect(geminiBilling(null, {}, loginHome())).toBe("subscription");
    expect(geminiBilling(null, { GEMINI_API_KEY: "k" }, loginHome())).toBe("api");
    // Neither (set up by hand, e.g. Vertex): billed per token.
    expect(geminiBilling(null, {}, emptyHome())).toBe("api");
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
      ({ provider: "gemini-cli", id, cost: zero }) as unknown as Parameters<typeof callCost>[0];
    // Priced from pi's Google table by the model that answered.
    expect(callCost(model("gemini-2.5-flash"), usage(), "api").costMicroUsd).toBe(300_000);
    const plan = callCost(model("gemini-2.5-pro"), usage(), "subscription");
    expect(plan.costMicroUsd).toBe(0);
    expect(plan.apiEquivalentMicroUsd).toBeGreaterThan(0);
    // An alias has no price of its own.
    expect(callCost(model("auto"), usage(), "api").costMicroUsd).toBe(0);
  });
});

describe.skipIf(!db)("gemini-cli backend through the Bridge", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let sql: postgres.Sql;
  let ownerCookie = "";
  let adminCookie = "";
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
  const home = loginHome();
  const savedKey = process.env.GEMINI_API_KEY;

  beforeAll(async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.SHIPMATE_GEMINI_BIN = fakeBin;
    process.env.SHIPMATE_GEMINI_HOME = home;
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
    for (const [email, role] of [
      ["a@example.com", "admin"],
      ["m@example.com", "member"],
    ]) {
      await api("POST", "/api/users", {
        email,
        displayName: role,
        password: "password1",
        role,
      });
    }
    adminCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "a@example.com", password: "password1" }, ""),
    );
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "m@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    const created = await api("POST", "/api/crew", {
      slug: "coder",
      manifestYaml:
        "name: Coder\nrole: code\nmodel: gemini-cli/flash\nbackend: gemini-cli\ngemini:\n  mode: edit\n",
      persona: "# Coder\nYou write code.",
    });
    expect(created.statusCode).toBe(200);
    convId = (await api("POST", "/api/conversations", { kind: "direct", crewSlug: "coder" })).json()
      .conversation.id;
  });

  afterAll(async () => {
    delete process.env.SHIPMATE_GEMINI_BIN;
    delete process.env.SHIPMATE_GEMINI_HOME;
    delete process.env.SHIPMATE_TEST_LEAK;
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    await sql?.end();
    await t?.app.close();
  });

  it("streams a full Gemini turn into messages and records its usage", async () => {
    const before = calls().length;
    const events = await turn(convId, "fix the bug");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const tools = events.filter((e) => e.type === "tool");
    expect(tools.map((e) => (e.type === "tool" ? `${e.phase}:${e.toolName}` : ""))).toEqual([
      "start:read",
      "end:read",
    ]);
    const msgs = (await api("GET", `/api/conversations/${convId}/messages`)).json().messages;
    expect(msgs.at(-1)).toMatchObject({
      role: "assistant",
      content: "Done: fix the bug",
      author: { kind: "crew", slug: "coder" },
    });

    // Keyed by the model that answered; a work login runs on its plan.
    const [usage] = await sql`select * from usage_events where conversation_id = ${convId}`;
    expect(usage).toMatchObject({ model: "gemini-cli/gemini-2.5-flash", billing: "subscription" });
    expect(Number(usage?.cost_micro_usd)).toBe(0);
    expect(Number(usage?.api_equivalent_micro_usd)).toBeGreaterThan(0);
    expect(Number(usage?.input_tokens)).toBe(40);
    expect(Number(usage?.cache_read_tokens)).toBe(80);

    const call = calls()[before];
    expect(call?.prompt).toBe("fix the bug");
    // The instructions ride in front of the message (no GEMINI.md to race on).
    expect(call?.input).toContain("You write code.");
    expect(existsSync(join(call?.cwd ?? "", "GEMINI.md"))).toBe(false);
    expect(call?.cwd).toMatch(/coder[/\\]cli-workspace$/);
    expect(call?.home).toBe(home);
    expect(call?.leaked).toEqual([]);
    const args = call?.args ?? [];
    expect(args[args.indexOf("-m") + 1]).toBe("flash");
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("auto_edit");
    expect(args).not.toContain("--resume");
    expect(call?.policy).toContain("run_shell_command");
    expect(call?.auth).toBe("oauth-personal");
  });

  it("lets owners save an API key, never shows it, and bills it as API spend", async () => {
    expect(
      (await api("PUT", "/api/gemini-cli/key", { key: "AIza-saved" }, adminCookie)).statusCode,
    ).toBe(403);
    const saved = await api("PUT", "/api/gemini-cli/key", { key: "AIza-saved" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().geminiCli).toMatchObject({ keySaved: true, authMethod: "api_key" });
    expect(saved.body).not.toContain("AIza-saved");
    const [row] = await sql`select ciphertext from secrets where ref = 'gemini-cli:api-key'`;
    expect(String(row?.ciphertext)).not.toContain("AIza-saved");
    try {
      const conv = (
        await api("POST", "/api/conversations", { kind: "direct", crewSlug: "coder" })
      ).json().conversation;
      await turn(conv.id, "fix the bug");
      expect(calls().at(-1)).toMatchObject({ apiKey: "AIza-saved", auth: "gemini-api-key" });
      const [usage] = await sql`select * from usage_events where conversation_id = ${conv.id}`;
      expect(usage).toMatchObject({ model: "gemini-cli/gemini-2.5-flash", billing: "api" });
      expect(Number(usage?.cost_micro_usd)).toBeGreaterThan(0);
    } finally {
      const removed = await api("PUT", "/api/gemini-cli/key", { key: null });
      expect(removed.json().geminiCli).toMatchObject({ keySaved: false, authMethod: "login" });
    }
  });

  it("resumes the Gemini session on the next message", async () => {
    const [conv] = await sql`select session_files from conversations where id = ${convId}`;
    const sid = ((conv?.session_files ?? {}) as Record<string, string>)["gemini-cli:coder"];
    expect(sid).toMatch(/^1c0ffee0-/);
    const before = calls().length;
    await turn(convId, "and the next one");
    const args = calls()[before]?.args ?? [];
    expect(args[args.indexOf("--resume") + 1]).toBe(sid);
  });

  it("shows Gemini errors with how to set it up", async () => {
    const events = await turn(convId, "fail please");
    const error = events.find((e) => e.type === "error");
    expect(error && "message" in error ? error.message : "").toContain("NO_BROWSER=true gemini");
  });

  it("lets a Captain on Gemini CLI route a message to a crew member", async () => {
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
      .replace(/^model:.*$/m, "model: gemini-cli/pro")
      .trimEnd()}\nbackend: gemini-cli\n`;
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
      expect(call?.settings?.mcpServers.shipmate).toMatchObject({
        httpUrl: expect.stringMatching(/\/api\/cli-mcp$/),
        trust: true,
      });
      expect(call?.token).toBe(true);
      expect(call?.input).toMatch(/deckhand: Deckhand, odd jobs/);
      expect(call?.input).toContain("mcp_shipmate_");
    } finally {
      await api("PUT", "/api/crew/captain", { manifestYaml: detail.manifestYaml });
    }
  });

  it("reports Gemini CLI status to admins only", async () => {
    const res = await api("GET", "/api/gemini-cli", undefined, adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().geminiCli).toMatchObject({
      installed: true,
      version: "0.64.0-fake",
      signedIn: true,
      authMethod: "login",
      email: "a@example.com",
      keySaved: false,
      configDir: home,
      signInCommand: "docker exec -it shipmate env NO_BROWSER=true gemini",
    });
    expect(res.json().geminiCli.models.map((m: { ref: string }) => m.ref)).toContain(
      "gemini-cli/flash",
    );
    expect((await api("GET", "/api/gemini-cli", undefined, memberCookie)).statusCode).toBe(403);
  });
});
