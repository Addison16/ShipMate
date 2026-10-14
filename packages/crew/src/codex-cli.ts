/**
 * The `codex-cli` crew backend: runs the unmodified official `codex` binary (`codex exec --json`)
 * and translates its JSONL events into the same events the Claude Code backend emits.
 *
 * What this module deliberately does NOT do: read, copy, store or forward the ChatGPT login.
 * The user signs the CLI in themselves (`codex login --device-auth` once) and the CLI keeps and
 * refreshes its own login in CODEX_HOME. Shipmate only starts the binary when someone sends a
 * message; there is no keep-alive of any kind.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { CodexCliSettings } from "@shipmate/core";
import { type ClaudeCliEvent, childEnv } from "./claude-cli.js";

/** The binary Shipmate runs: `SHIPMATE_CODEX_BIN` when set (tests, custom installs), else `codex`. */
export function codexCliBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPMATE_CODEX_BIN?.trim() || "codex";
}

/** Where the CLI keeps its own login and sessions (the image sets /data/codex). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || `${env.HOME ?? "~"}/.codex`;
}

/** The command that signs Codex in on a server (no browser needed). */
export const CODEX_SIGN_IN_COMMAND = "docker exec -it shipmate codex login --device-auth";

export const CODEX_SIGN_IN_HINT = `Sign in once with your own ChatGPT account: run \`${CODEX_SIGN_IN_COMMAND}\` and follow the link it shows.`;

/** The environment variable that carries the per-turn token for Shipmate's own tools. */
export const CODEX_MCP_TOKEN_ENV = "CODEX_SHIPMATE_MCP_TOKEN";

export class CodexCliMissingError extends Error {
  constructor(bin: string) {
    super(
      `The Codex CLI (\`${bin}\`) is not installed on this server. Install it with \`npm install -g @openai/codex\` (the Shipmate image includes it), or switch this crew member's engine to Shipmate.`,
    );
    this.name = "CodexCliMissingError";
  }
}

export type CodexCliEvent = ClaudeCliEvent;

export interface CodexCliUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface CodexCliResult {
  /** The CLI's thread id; pass it as `resume` to continue the conversation. */
  sessionId: string | null;
  /** The final reply text. */
  text: string;
  isError: boolean;
  error: string | null;
  usage: CodexCliUsage;
  /** Files of pictures Codex made this turn, when its events name them. */
  images: string[];
  aborted: boolean;
}

export interface CodexCliRunOptions {
  /** The crew member's working directory. */
  cwd: string;
  prompt: string;
  /** Sent as Codex's developer instructions: CREW.md plus Shipmate context. */
  instructions?: string;
  /** Continue this Codex thread (a conversation resuming). */
  resume?: string;
  /** The model id (without `codex/`); the CLI's own default when unset. */
  model?: string;
  settings?: Partial<CodexCliSettings>;
  /** Shipmate's per-turn tool server (streamable HTTP, bearer token). */
  mcp?: { url: string; token: string };
  /** Defaults to codexCliBin(). */
  bin?: string;
  /** Defaults to process.env without Shipmate's own secrets. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: CodexCliEvent) => void;
}

/** A TOML string value for `-c key=value` (JSON strings are valid TOML basic strings). */
const toml = (s: string) => JSON.stringify(s);

/** The command line for one turn. The prompt goes to stdin (`-`), never into argv. */
export function codexCliArgs(
  options: Pick<CodexCliRunOptions, "instructions" | "resume" | "model" | "settings" | "mcp">,
): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    options.settings?.sandbox ?? "read-only",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.instructions) {
    args.push("-c", `developer_instructions=${toml(options.instructions)}`);
  }
  if (options.mcp) {
    args.push(
      "-c",
      `mcp_servers.shipmate.url=${toml(options.mcp.url)}`,
      "-c",
      `mcp_servers.shipmate.bearer_token_env_var=${toml(CODEX_MCP_TOKEN_ENV)}`,
      // Shipmate's own approval gate decides on these calls; nobody can answer Codex's prompts.
      "-c",
      `mcp_servers.shipmate.default_tools_approval_mode=${toml("approve")}`,
    );
  }
  if (options.resume) args.push("resume", options.resume);
  args.push("-");
  return args;
}

/** Run one turn. Resolves with the result; rejects only when the CLI cannot be started at all. */
export async function runCodexCli(options: CodexCliRunOptions): Promise<CodexCliResult> {
  const first = await runOnce(options);
  // A thread the CLI no longer has (CODEX_HOME reset): start a fresh one instead.
  if (
    options.resume &&
    first.isError &&
    !first.aborted &&
    /no rollout found|thread\/resume failed|session.*not found/i.test(first.error ?? "")
  ) {
    const { resume: _drop, ...fresh } = options;
    return runOnce(fresh);
  }
  return first;
}

function runOnce(options: CodexCliRunOptions): Promise<CodexCliResult> {
  const bin = options.bin ?? codexCliBin();
  const emit = options.onEvent ?? (() => {});
  const result: CodexCliResult = {
    sessionId: null,
    text: "",
    isError: false,
    error: null,
    usage: { input: 0, output: 0, cacheRead: 0 },
    images: [],
    aborted: false,
  };

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ ...result, aborted: true, isError: true });
      return;
    }
    let child: ChildProcess;
    try {
      const env = { ...(options.env ?? childEnv()) };
      if (options.mcp) env[CODEX_MCP_TOKEN_ENV] = options.mcp.token;
      child = spawn(bin, codexCliArgs(options), {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so cancelling also stops the commands it started.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(isMissing(err) ? new CodexCliMissingError(bin) : err);
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
      if (isMissing(err)) reject(new CodexCliMissingError(bin));
      else reject(err);
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", kill);
      clearTimeout(killTimer);
      if (buffer.trim()) handle(buffer);
      result.sessionId = parser.threadId;
      result.text = parser.text.trim();
      result.usage = parser.usage;
      result.images = [...parser.images];
      if (result.aborted) {
        result.isError = true;
        result.error = null;
      } else if (parser.failed || !parser.completed) {
        result.isError = true;
        const why = stderr
          .split("\n")
          .filter((l) => l.trim() && !/^WARNING:|^\d{4}-\d\d-\d\dT.*\b(WARN|INFO|DEBUG)\b/.test(l))
          .slice(-5)
          .join("\n");
        result.error =
          parser.failed ??
          (why.trim() ||
            parser.lastError ||
            `the Codex CLI exited ${signal ? `on ${signal}` : `with code ${code}`} without a reply`);
      }
      if (
        result.isError &&
        result.error &&
        /401|unauthorized|log ?in|logged in|auth|api key|credential/i.test(result.error)
      ) {
        result.error = `${result.error}\n\n${CODEX_SIGN_IN_HINT}`;
      }
      resolve(result);
    });

    child.stdin?.end(options.prompt);
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

/**
 * Turns `codex exec --json` events into CodexCliEvents. Codex sends whole items, not deltas:
 * each finished agent message is one text event, and commands, file changes, web searches and
 * MCP tool calls show as tools.
 */
export class EventParser {
  threadId: string | null = null;
  text = "";
  usage: CodexCliUsage = { input: 0, output: 0, cacheRead: 0 };
  completed = false;
  /** The turn.failed message, when the turn failed. */
  failed: string | null = null;
  /** The last top-level error event (retries, warnings). */
  lastError: string | null = null;
  /** Saved files of pictures made with Codex's built-in image tool. */
  images = new Set<string>();
  #started = new Set<string>();

  constructor(private readonly emit: (e: CodexCliEvent) => void) {}

  feed(msg: Json) {
    switch (msg.type) {
      case "thread.started":
        if (typeof msg.thread_id === "string") {
          this.threadId = msg.thread_id;
          this.emit({ type: "init", sessionId: msg.thread_id, model: null });
        }
        break;
      case "turn.completed": {
        this.completed = true;
        const u = (msg.usage ?? {}) as Json;
        // Codex counts cached input inside input_tokens.
        const cached = num(u.cached_input_tokens);
        this.usage = {
          input: this.usage.input + Math.max(0, num(u.input_tokens) - cached),
          output: this.usage.output + num(u.output_tokens),
          cacheRead: this.usage.cacheRead + cached,
        };
        break;
      }
      case "turn.failed":
        this.failed = str((msg.error as Json | undefined)?.message) || "the Codex turn failed";
        break;
      case "error":
        this.lastError = str(msg.message) || this.lastError;
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.#item(msg.type, (msg.item ?? {}) as Json);
        break;
    }
  }

  #item(phase: string, item: Json) {
    const id = str(item.id);
    const type = str(item.type);
    const saved = str(item.saved_path) || str(item.savedPath);
    if (saved && /image/.test(type)) this.images.add(saved);
    if (type === "agent_message") {
      if (phase !== "item.completed") return;
      const t = str(item.text);
      if (!t) return;
      const joined = this.text ? `\n\n${t}` : t;
      this.text += joined;
      this.emit({ type: "text", text: joined });
      return;
    }
    const tool = toolOf(type, item);
    if (!tool || !id) return;
    if (!this.#started.has(id)) {
      this.#started.add(id);
      this.emit({ type: "tool_start", id, name: tool.name, input: tool.input });
    }
    if (phase === "item.completed") {
      this.emit({
        type: "tool_end",
        id,
        name: tool.name,
        output: tool.output,
        isError: tool.isError,
      });
    }
  }
}

function toolOf(
  type: string,
  item: Json,
): { name: string; input: unknown; output: unknown; isError: boolean } | null {
  const failed = str(item.status) === "failed";
  switch (type) {
    case "command_execution":
      return {
        name: "bash",
        input: { command: str(item.command) },
        output: str(item.aggregated_output),
        isError: failed || (typeof item.exit_code === "number" && item.exit_code !== 0),
      };
    case "file_change":
      return {
        name: "edit",
        input: {
          files: Array.isArray(item.changes)
            ? item.changes.map((c) => str((c as Json | null)?.path)).filter(Boolean)
            : [],
        },
        output: str(item.status),
        isError: failed,
      };
    case "web_search":
      return { name: "web_search", input: { query: str(item.query) }, output: "", isError: false };
    case "mcp_tool_call": {
      const error = (item.error as Json | null | undefined)?.message;
      const result = item.result as Json | null | undefined;
      return {
        name: `mcp__${str(item.server)}__${str(item.tool)}`,
        input: item.arguments ?? {},
        output: typeof error === "string" ? error : (result?.content ?? null),
        isError: failed || typeof error === "string",
      };
    }
    default:
      return null;
  }
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

export interface CodexCliStatus {
  installed: boolean;
  version: string | null;
  /** From `codex login status` (its exit code and wording); credentials are never read. */
  signedIn: boolean;
  authMethod: "chatgpt" | "api_key" | null;
  bin: string;
  configDir: string;
}

/** Ask the CLI for its version and whether it is signed in. Never opens its credential files. */
export async function codexCliStatus(
  options: { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CodexCliStatus> {
  const bin = options.bin ?? codexCliBin(options.env);
  const env = options.env ?? childEnv();
  const base = { bin, configDir: codexHome(options.env) };
  const timeoutMs = options.timeoutMs ?? 15_000;
  const version = await capture(bin, ["--version"], env, timeoutMs);
  if (version.missing) {
    return { ...base, installed: false, version: null, signedIn: false, authMethod: null };
  }
  const login = await capture(bin, ["login", "status"], env, timeoutMs);
  const said = login.output.toLowerCase();
  const signedIn = login.code === 0 && !said.includes("not logged in");
  const authMethod = !signedIn
    ? null
    : said.includes("chatgpt")
      ? ("chatgpt" as const)
      : said.includes("api key")
        ? ("api_key" as const)
        : null;
  const v = /(\d+\.\d+\.\d+[^\s]*)/.exec(version.output);
  return {
    ...base,
    installed: version.code === 0 || !!v,
    version: v?.[1] ?? (version.output.trim() || null),
    signedIn,
    authMethod,
  };
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
    // `codex login status` writes to stderr on some versions.
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
