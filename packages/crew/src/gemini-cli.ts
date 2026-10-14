/**
 * The `gemini-cli` crew backend: runs the unmodified official Gemini CLI (`gemini -p "" -o
 * stream-json`) and translates its JSON lines into the same events the Claude Code backend emits.
 *
 * What this module deliberately does NOT do: read, copy, store or forward the Google login. The
 * user signs the CLI in themselves (`NO_BROWSER=true gemini` once) and the CLI keeps and refreshes
 * its own login under GEMINI_CLI_HOME; Shipmate only checks that the file is there. An API key an
 * owner gives Shipmate goes to the CLI in its environment, never on the command line. Shipmate
 * only starts the binary when someone sends a message; there is no keep-alive of any kind.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GeminiCliSettings } from "@shipmate/core";
import { type ClaudeCliEvent, childEnv } from "./claude-cli.js";

/** Where the CLI keeps its login, chats and settings: its GEMINI_CLI_HOME (the image: /data/gemini). */
export function geminiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPMATE_GEMINI_HOME?.trim() || "/data/gemini";
}

/** The binary Shipmate runs: `SHIPMATE_GEMINI_BIN` when set (tests, custom installs), else `gemini`. */
export function geminiCliBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPMATE_GEMINI_BIN?.trim() || "gemini";
}

/** The command that signs the Gemini CLI in with a Google login (it prints a link, then asks for a code). */
export const GEMINI_SIGN_IN_COMMAND = "docker exec -it shipmate env NO_BROWSER=true gemini";

export const GEMINI_SIGN_IN_HINT = `Gemini CLI needs a Gemini API key (Providers → Gemini) or a Gemini Code Assist work login: run \`${GEMINI_SIGN_IN_COMMAND}\`. Google AI Pro plans don't work with Gemini CLI.`;

/** The environment variable that carries the per-turn token for Shipmate's own tools. */
export const GEMINI_MCP_TOKEN_ENV = "GEMINI_SHIPMATE_MCP_TOKEN";

/** The name of Shipmate's tool server in the CLI's settings.json; its tools are `mcp_shipmate_*`. */
const MCP_SERVER = "shipmate";

/** The policy file Shipmate keeps in the workspace's `.gemini/` folder (passed with --policy). */
export const GEMINI_POLICY_FILE = "shipmate-policy.toml";

/**
 * A turn is stopped after this long. The CLI retries rate-limited (429) calls for minutes on its
 * own, so without a limit a turn could hang far longer than anyone waits.
 */
export const GEMINI_TURN_TIMEOUT_MS = 10 * 60_000;

/** The CLI's exit code when it has no way to sign in. */
const EXIT_NO_AUTH = 41;

export class GeminiCliMissingError extends Error {
  constructor(bin: string) {
    super(
      `The Gemini CLI (\`${bin}\`) is not installed on this server. Install it with \`npm install -g @google/gemini-cli\` (the Shipmate image includes it), or switch this crew member's engine to Shipmate.`,
    );
    this.name = "GeminiCliMissingError";
  }
}

export type GeminiCliEvent = ClaudeCliEvent;

export interface GeminiCliUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface GeminiCliResult {
  /** The CLI's session id; pass it as `resume` to continue the conversation. */
  sessionId: string | null;
  /** The final reply text. */
  text: string;
  isError: boolean;
  error: string | null;
  usage: GeminiCliUsage;
  /** Usage per model that actually answered (`auto`, `pro` and `flash` pick one per call). */
  models: Array<{ id: string; usage: GeminiCliUsage }>;
  aborted: boolean;
  /** Stopped after GEMINI_TURN_TIMEOUT_MS. */
  timedOut: boolean;
}

export interface GeminiCliRunOptions {
  /** The crew member's working directory (the CLI's workspace). */
  cwd: string;
  prompt: string;
  /** CREW.md plus Shipmate context, sent ahead of the prompt (see geminiPrompt). */
  instructions?: string;
  /** Continue this Gemini session (a conversation resuming). */
  resume?: string;
  /** The model id or alias (without `gemini-cli/`); the CLI's own default when unset. */
  model?: string;
  settings?: Partial<GeminiCliSettings>;
  /** Shipmate's per-turn tool server (streamable HTTP, bearer token). */
  mcp?: { url: string; token: string };
  /** A Gemini API key saved in Shipmate; used ahead of a Google login. */
  apiKey?: string | null;
  /** Defaults to geminiCliBin(). */
  bin?: string;
  /** Defaults to geminiHome(). */
  home?: string;
  /** Defaults to process.env without Shipmate's own secrets. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to GEMINI_TURN_TIMEOUT_MS. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: GeminiCliEvent) => void;
}

/** `--approval-mode` for each setting. Headless, the CLI drops every tool that would need asking. */
export function geminiApprovalMode(settings?: Partial<GeminiCliSettings>): string {
  switch (settings?.mode ?? "read-only") {
    case "anything":
      return "yolo";
    case "edit":
      return "auto_edit";
    default:
      return "default";
  }
}

/**
 * The command line for one turn. The CLI puts what it reads on stdin in front of the `-p` text,
 * so the prompt goes to stdin with an empty `-p`, never into argv.
 */
export function geminiCliArgs(
  options: Pick<GeminiCliRunOptions, "cwd" | "resume" | "model" | "settings" | "mcp">,
): string[] {
  const args = [
    "-p",
    "",
    "-o",
    "stream-json",
    // The workspace is Shipmate's own folder for this crew member.
    "--skip-trust",
    "--approval-mode",
    geminiApprovalMode(options.settings),
    // Only Shipmate's server, never others from the CLI's global settings ("none" names nothing).
    "--allowed-mcp-server-names",
    options.mcp ? MCP_SERVER : "none",
  ];
  if ((options.settings?.mode ?? "read-only") !== "anything") {
    args.push("--policy", join(options.cwd, ".gemini", GEMINI_POLICY_FILE));
  }
  if (options.model) args.push("-m", options.model);
  if (options.resume) args.push("--resume", options.resume);
  return args;
}

/**
 * The CLI has no per-run system prompt option: its GEMINI.md files are shared by every turn of
 * this crew member (or, in GEMINI_CLI_HOME, of all of them), so two people talking at once would
 * race on them, and GEMINI_SYSTEM_MD replaces the CLI's whole prompt. The instructions go in front
 * of the message instead.
 */
export function geminiPrompt(prompt: string, instructions?: string): string {
  if (!instructions?.trim()) return prompt;
  return `<shipmate-instructions>\n${instructions.trim()}\n</shipmate-instructions>\n\n${prompt}`;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** A TOML string (JSON strings are valid TOML basic strings). */
const toml = (v: string | string[]) =>
  Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v);

/** Gemini's file tools, by what they do. */
const READ_TOOLS = [
  "read_file",
  "read_many_files",
  "list_directory",
  "glob",
  "grep_search",
  "search_file_content",
];
const EDIT_TOOLS = ["write_file", "replace"];

/**
 * The policy for one crew member (`.gemini/shipmate-policy.toml` in its workspace, loaded with
 * --policy at the user tier, above the CLI's defaults). Its content depends only on the folder and
 * the mode, so turns running side by side write the same bytes. None in "anything" mode.
 *
 * Gemini's file tools only reach the workspace, but also the CLI's own folder for this project
 * under GEMINI_CLI_HOME, which holds the transcripts of every chat with this crew member,
 * other people's included. So any path that is absolute outside the folder, starts with `~` or
 * has `..` in it is refused. Shell commands and edits to `.gemini/` (its own settings, so it
 * cannot widen them) are refused too; in read-only mode, every edit.
 */
export function geminiPolicy(
  options: Pick<GeminiCliRunOptions, "cwd" | "settings">,
): string | null {
  const mode = options.settings?.mode ?? "read-only";
  if (mode === "anything") return null;
  const elsewhere = `(?:~|/(?!${escapeRegex(options.cwd.replace(/^\/+|\/+$/g, ""))}(?:/|"))|[^"]*\\.\\.)`;
  const rule = (r: { toolName: string | string[]; argsPattern?: string; denyMessage: string }) =>
    [
      "[[rule]]",
      `toolName = ${toml(r.toolName)}`,
      ...(r.argsPattern ? [`argsPattern = ${toml(r.argsPattern)}`] : []),
      `decision = "deny"`,
      "priority = 900",
      `denyMessage = ${toml(r.denyMessage)}`,
    ].join("\n");
  const outside = "Only files in your own folder.";
  return `${[
    "# Written by Shipmate for this crew member. Changes are overwritten.",
    rule({
      toolName: [...READ_TOOLS, ...EDIT_TOOLS],
      argsPattern: `"(?:file_path|dir_path|include_pattern)":"${elsewhere}`,
      denyMessage: outside,
    }),
    rule({ toolName: "glob", argsPattern: `"pattern":"${elsewhere}`, denyMessage: outside }),
    rule({
      toolName: "read_many_files",
      argsPattern: `"(?:include|exclude)":\\[(?:"[^"]*",)*"${elsewhere}`,
      denyMessage: outside,
    }),
    rule({
      toolName: EDIT_TOOLS,
      argsPattern: `"file_path":"(?:[^"]*/)?\\.gemini(?:/|")`,
      denyMessage: "Its own settings stay as Shipmate set them.",
    }),
    rule({ toolName: "run_shell_command", denyMessage: "No shell commands in this mode." }),
    ...(mode === "edit"
      ? []
      : [rule({ toolName: EDIT_TOOLS, denyMessage: "Read only: no file changes." })]),
  ].join("\n\n")}\n`;
}

/**
 * The files Shipmate keeps in a crew member's workspace for the CLI, by path under `.gemini/`
 * (null: remove it). The CLI reads `.gemini/settings.json` there on top of its global one, so
 * Shipmate's tool server is configured per workspace. Their content depends only on the crew
 * member's settings and Shipmate's address, never on the person or the turn: the MCP token comes
 * from the child's environment (`${...}`), so turns running at once write the same bytes.
 */
export function geminiProjectFiles(
  options: Pick<GeminiCliRunOptions, "cwd" | "settings" | "mcp">,
): Record<string, string | null> {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    "settings.json": options.mcp
      ? json({
          mcpServers: {
            [MCP_SERVER]: {
              httpUrl: options.mcp.url,
              headers: { Authorization: `Bearer \${${GEMINI_MCP_TOKEN_ENV}}` },
              // Its tools are offered without asking; Shipmate's approval gate decides on each call.
              trust: true,
            },
          },
        })
      : null,
    [GEMINI_POLICY_FILE]: geminiPolicy(options),
  };
}

/**
 * Write the workspace's `.gemini/` files, each only when it changed and through a temporary file
 * renamed into place, so a turn starting meanwhile never reads half a file.
 */
export function writeGeminiProjectFiles(cwd: string, files: Record<string, string | null>) {
  const dir = join(cwd, ".gemini");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    let now: string | null = null;
    try {
      now = readFileSync(path, "utf8");
    } catch {
      // not there
    }
    // A turn without Shipmate's tools leaves settings.json in place: --allowed-mcp-server-names
    // keeps the server off for that turn.
    if (content === null) {
      if (name !== "settings.json" && now !== null) rmSync(path, { force: true });
      continue;
    }
    if (now === content) continue;
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }
}

/** The CLI's Google login file under its home (Shipmate only checks that it is there). */
export function geminiLoginFile(home: string): string {
  return join(home, ".gemini", "oauth_creds.json");
}

/**
 * How a run signs in: an API key (Shipmate's, else GEMINI_API_KEY) ahead of a Google login, and
 * the CLI's `GEMINI_CLI_AUTH_OVERRIDE` for it, so the choice is the same for status, billing and
 * the run. Neither: the CLI decides (e.g. Vertex set up by hand), or exits saying it needs one.
 */
export function geminiAuth(
  env: NodeJS.ProcessEnv,
  home: string,
  apiKey?: string | null,
): { method: "api_key" | "login" | null; key: string | null; override: string | null } {
  const key = apiKey?.trim() || env.GEMINI_API_KEY?.trim() || null;
  if (key) return { method: "api_key", key, override: "gemini-api-key" };
  if (existsSync(geminiLoginFile(home))) {
    return { method: "login", key: null, override: "oauth-personal" };
  }
  return { method: null, key: null, override: null };
}

/** Run one turn. Resolves with the result; rejects only when the CLI cannot be started at all. */
export async function runGeminiCli(options: GeminiCliRunOptions): Promise<GeminiCliResult> {
  writeGeminiProjectFiles(options.cwd, geminiProjectFiles(options));
  const first = await runOnce(options);
  // A session the CLI no longer has (its home reset, or another folder): start a fresh one.
  if (
    options.resume &&
    first.isError &&
    !first.aborted &&
    /invalid session identifier|session.{0,40}not found|no (previous )?sessions? found/i.test(
      first.error ?? "",
    )
  ) {
    const { resume: _drop, ...fresh } = options;
    return runOnce(fresh);
  }
  return first;
}

function runOnce(options: GeminiCliRunOptions): Promise<GeminiCliResult> {
  const bin = options.bin ?? geminiCliBin();
  const home = options.home ?? geminiHome();
  const emit = options.onEvent ?? (() => {});
  const timeoutMs = options.timeoutMs ?? GEMINI_TURN_TIMEOUT_MS;
  const result: GeminiCliResult = {
    sessionId: null,
    text: "",
    isError: false,
    error: null,
    usage: { input: 0, output: 0, cacheRead: 0 },
    models: [],
    aborted: false,
    timedOut: false,
  };

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ ...result, aborted: true, isError: true });
      return;
    }
    let child: ChildProcess;
    try {
      const env = { ...(options.env ?? childEnv()) };
      // The CLI keeps its login, chats and settings under GEMINI_CLI_HOME/.gemini.
      env.GEMINI_CLI_HOME = home;
      // Same as --skip-trust, but also set before the CLI reads the workspace's settings.json.
      env.GEMINI_CLI_TRUST_WORKSPACE = "true";
      const auth = geminiAuth(env, home, options.apiKey);
      delete env.GEMINI_CLI_AUTH_OVERRIDE;
      if (auth.key) env.GEMINI_API_KEY = auth.key;
      if (auth.override) env.GEMINI_CLI_AUTH_OVERRIDE = auth.override;
      if (options.mcp) env[GEMINI_MCP_TOKEN_ENV] = options.mcp.token;
      else delete env[GEMINI_MCP_TOKEN_ENV];
      child = spawn(bin, geminiCliArgs(options), {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so cancelling also stops the commands it started.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(isMissing(err) ? new GeminiCliMissingError(bin) : err);
      return;
    }

    const parser = new EventParser(emit);
    let stderr = "";
    let buffer = "";
    let killTimer: NodeJS.Timeout | undefined;

    const kill = () => {
      result.aborted = true;
      signalTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalTree(child, "SIGKILL"), 3000);
      killTimer.unref?.();
    };
    options.signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(() => {
      result.timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();

    const handle = (line: string) => {
      const msg = parseLine(line);
      if (msg) parser.feed(msg);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdin?.on("error", () => {});

    child.on("error", (err) => {
      options.signal?.removeEventListener("abort", kill);
      clearTimeout(killTimer);
      clearTimeout(timer);
      if (isMissing(err)) reject(new GeminiCliMissingError(bin));
      else reject(err);
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", kill);
      clearTimeout(killTimer);
      clearTimeout(timer);
      if (buffer.trim()) handle(buffer);
      result.sessionId = parser.sessionId;
      result.text = parser.text.trim();
      result.usage = parser.usage;
      result.models = parser.models;
      if (result.timedOut) {
        result.isError = true;
        result.aborted = false;
        result.error = `the Gemini CLI did not finish within ${Math.round(timeoutMs / 60_000)} minutes, so Shipmate stopped it (Google may be limiting how often this account can ask). Try again later.`;
      } else if (result.aborted) {
        result.isError = true;
        result.error = null;
      } else if (parser.failed || !parser.completed || code) {
        result.isError = true;
        const why = stderr
          .split("\n")
          .filter(
            (l) =>
              l.trim() &&
              !/^(Warning: 256-color|YOLO mode is enabled|MCP issues detected|Loaded cached credentials)/.test(
                l,
              ),
          )
          .slice(-5)
          .join("\n");
        result.error =
          parser.failed ??
          (why.trim() ||
            parser.lastError ||
            `the Gemini CLI exited ${signal ? `on ${signal}` : `with code ${code}`} without a reply`);
      }
      if (
        result.isError &&
        result.error &&
        (code === EXIT_NO_AUTH ||
          /401|403|unauthori[sz]ed|permission denied|api key|auth method|credential|log ?in|sign ?in|not (eligible|supported)/i.test(
            result.error,
          ))
      ) {
        result.error = `${result.error}\n\n${GEMINI_SIGN_IN_HINT}`;
      }
      resolve(result);
    });

    child.stdin?.end(geminiPrompt(options.prompt, options.instructions));
  });
}

type Json = Record<string, unknown>;

function parseLine(line: string): Json | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" ? (v as Json) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

/** One stats block (`result.stats` or a model in it): Gemini counts cached input inside input_tokens. */
function usageOf(s: Json): GeminiCliUsage {
  const cached = num(s.cached);
  return {
    input: typeof s.input === "number" ? num(s.input) : Math.max(0, num(s.input_tokens) - cached),
    output: num(s.output_tokens),
    cacheRead: cached,
  };
}

/**
 * Turns `gemini -o stream-json` lines into GeminiCliEvents. Assistant text arrives in pieces
 * (`delta: true`), each one a text event; a piece after a tool call starts a new paragraph. Tool
 * calls come as `tool_use` and `tool_result` pairs, matched by `tool_id`.
 */
export class EventParser {
  sessionId: string | null = null;
  text = "";
  usage: GeminiCliUsage = { input: 0, output: 0, cacheRead: 0 };
  models: Array<{ id: string; usage: GeminiCliUsage }> = [];
  completed = false;
  /** The result's error, when it reported one. */
  failed: string | null = null;
  /** The last non-fatal error line (retries, warnings). */
  lastError: string | null = null;
  #tools = new Map<string, { name: string; input: unknown }>();
  /** A tool ran since the last text, so the next text starts a new paragraph. */
  #gap = false;

  constructor(private readonly emit: (e: GeminiCliEvent) => void) {}

  feed(msg: Json) {
    switch (msg.type) {
      case "init":
        if (typeof msg.session_id === "string") {
          this.sessionId = msg.session_id;
          this.emit({
            type: "init",
            sessionId: msg.session_id,
            model: typeof msg.model === "string" ? msg.model : null,
          });
        }
        break;
      case "message": {
        if (msg.role !== "assistant") return;
        let t = str(msg.content);
        if (!t) return;
        if (this.#gap && this.text && !this.text.endsWith("\n\n")) {
          t = `${this.text.endsWith("\n") ? "\n" : "\n\n"}${t}`;
        }
        this.#gap = false;
        this.text += t;
        this.emit({ type: "text", text: t });
        break;
      }
      case "tool_use": {
        const id = str(msg.tool_id);
        if (!id) return;
        const tool = toolOf(str(msg.tool_name), obj(msg.parameters));
        this.#tools.set(id, tool);
        this.#gap = true;
        this.emit({ type: "tool_start", id, name: tool.name, input: tool.input });
        break;
      }
      case "tool_result": {
        const id = str(msg.tool_id);
        const tool = this.#tools.get(id);
        if (!tool) return;
        this.#tools.delete(id);
        const isError = msg.status === "error";
        this.emit({
          type: "tool_end",
          id,
          name: tool.name,
          output: isError
            ? str(obj(msg.error).message) || str(msg.output) || "failed"
            : str(msg.output),
          isError,
        });
        break;
      }
      case "error":
        this.lastError = str(msg.message) || this.lastError;
        break;
      case "result": {
        this.completed = true;
        if (msg.status !== "success") {
          const e = msg.error;
          this.failed = str(obj(e).message) || str(e) || this.lastError || "the Gemini turn failed";
        }
        const stats = obj(msg.stats);
        this.usage = usageOf(stats);
        this.models = Object.entries(obj(stats.models))
          .map(([id, s]) => ({ id, usage: usageOf(obj(s)) }))
          .filter((m) => m.usage.input || m.usage.output || m.usage.cacheRead);
        break;
      }
    }
  }
}

/** A tool call's name in Shipmate's terms and its input. */
function toolOf(name: string, params: Json): { name: string; input: unknown } {
  switch (name) {
    case "run_shell_command":
      return { name: "bash", input: { command: str(params.command) } };
    case "replace":
    case "write_file":
      return { name: "edit", input: { files: [str(params.file_path)].filter(Boolean) } };
    case "read_file":
      return { name: "read", input: { path: str(params.file_path) } };
    case "read_many_files":
      return { name: "read", input: { paths: params.include ?? [] } };
    case "list_directory":
      return { name: "read", input: { path: str(params.dir_path) || "." } };
    case "glob":
      return { name: "read", input: { pattern: str(params.pattern) } };
    case "grep_search":
    case "search_file_content":
      return {
        name: "read",
        input: { pattern: str(params.pattern), path: str(params.dir_path) || "." },
      };
    case "google_web_search":
      return { name: "web_search", input: { query: str(params.query) } };
    case "web_fetch":
      return { name: "web_fetch", input: { prompt: str(params.prompt) } };
  }
  // Shipmate's tools: `mcp_shipmate_remember` → `mcp__shipmate__remember`, as the others name them.
  const prefix = `mcp_${MCP_SERVER}_`;
  if (name.startsWith(prefix)) {
    return { name: `mcp__${MCP_SERVER}__${name.slice(prefix.length)}`, input: params };
  }
  return { name, input: params };
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function signalTree(child: ChildProcess, sig: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

// ---------- status ----------

/** The CLI has no command that lists models: its aliases, then models it names in its docs. */
export const GEMINI_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "auto", name: "Auto" },
  { id: "pro", name: "Pro" },
  { id: "flash", name: "Flash" },
  { id: "flash-lite", name: "Flash-Lite" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
];

export interface GeminiCliStatus {
  installed: boolean;
  version: string | null;
  /** An API key is set, or the Google login file is there; its content is never read. */
  signedIn: boolean;
  /** "api_key" when a key is set (used first), "login" with a Google login. */
  authMethod: "login" | "api_key" | null;
  /** The account the CLI recorded for its login (google_accounts.json), when there is one. */
  email: string | null;
  /** GEMINI_API_KEY is set in Shipmate's environment. */
  keyInEnv: boolean;
  models: Array<{ id: string; name: string }>;
  bin: string;
  configDir: string;
}

/** The CLI's version, and whether it has an API key or a Google login. Never opens the login. */
export async function geminiCliStatus(
  options: {
    bin?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** A key saved in Shipmate. */
    apiKey?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<GeminiCliStatus> {
  const bin = options.bin ?? geminiCliBin(options.env);
  const home = options.home ?? geminiHome(options.env);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ? childEnv(options.env) : childEnv()),
    GEMINI_CLI_HOME: home,
  };
  const auth = geminiAuth(env, home, options.apiKey);
  const base = {
    bin,
    configDir: home,
    signedIn: auth.method !== null,
    authMethod: auth.method,
    email: auth.method === "login" ? loginEmail(home) : null,
    keyInEnv: !!env.GEMINI_API_KEY?.trim(),
    models: GEMINI_MODELS.map((m) => ({ ...m })),
  };
  const version = await capture(bin, ["--version"], env, options.timeoutMs ?? 15_000);
  if (version.missing) return { ...base, installed: false, version: null };
  const v = /(\d+\.\d+\.\d+[^\s]*)/.exec(version.output);
  return {
    ...base,
    installed: version.code === 0 || !!v,
    version: v?.[1] ?? (version.output.trim() || null),
  };
}

/** The account in the CLI's google_accounts.json (`{ active: email }`), not its credentials. */
function loginEmail(home: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(home, ".gemini", "google_accounts.json"), "utf8"));
    return str(obj(v).active) || null;
  } catch {
    return null;
  }
}

function capture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; missing: boolean }> {
  return new Promise((resolve) => {
    let output = "";
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, output: "", missing: isMissing(err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    const add = (c: string) => {
      output = (output + c).slice(0, 20_000);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", add);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", add);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output, missing: isMissing(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, missing: false });
    });
  });
}
