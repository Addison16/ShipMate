/**
 * The `claude-code-cli` crew backend (§11, §12): runs the unmodified official `claude` binary in
 * print mode and translates its stream-json output into events Shipmate understands.
 *
 * What this module deliberately does NOT do: read, copy, store or forward Claude.ai credentials
 * or session tokens. The user signs the CLI in themselves (`claude` once, or `claude setup-token`
 * for headless use) and the CLI keeps and refreshes its own login in CLAUDE_CONFIG_DIR. Shipmate
 * only starts the binary when someone sends a message; there is no keep-alive of any kind.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { ClaudeCliSettings } from "@shipmate/core";

/** The binary Shipmate runs: `SHIPMATE_CLAUDE_BIN` when set (tests, custom installs), else `claude`. */
export function claudeCliBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPMATE_CLAUDE_BIN?.trim() || "claude";
}

/** Where the CLI keeps its own login and sessions (the image sets /data/claude). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || `${env.HOME ?? "~"}/.claude`;
}

/** How to sign the CLI in; shown by the status endpoint and in errors. */
export const CLAUDE_CLI_SIGN_IN_HINT =
  "Sign in once with your own Claude account: run `docker exec -it shipmate claude` and follow the prompts (or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for the container yourself).";

export class ClaudeCliMissingError extends Error {
  constructor(bin: string) {
    super(
      `The Claude Code CLI (\`${bin}\`) is not installed on this server. Install it with \`npm install -g @anthropic-ai/claude-code\` (the Shipmate image includes it), or switch this crew member's backend to pi.`,
    );
    this.name = "ClaudeCliMissingError";
  }
}

export type ClaudeCliEvent =
  | { type: "init"; sessionId: string; model: string | null }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; output: unknown; isError: boolean };

export interface ClaudeCliUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ClaudeCliResult {
  /** The CLI's session id; pass it as `resume` to continue the conversation. */
  sessionId: string | null;
  /** The final reply text. */
  text: string;
  isError: boolean;
  /** Why the run failed (when isError and not aborted). */
  error: string | null;
  /** The cost the CLI reports for this run (`total_cost_usd`), in USD. */
  costUsd: number;
  usage: ClaudeCliUsage;
  /** The model that answered, as the CLI names it. */
  model: string | null;
  /**
   * Where the CLI got its credentials (`apiKeySource` on its init message): "none" when it is
   * signed in with a Claude subscription, else the API key's source. Null when not reported.
   */
  apiKeySource: string | null;
  aborted: boolean;
}

export interface ClaudeCliRunOptions {
  /** The crew member's working directory (its folder). */
  cwd: string;
  prompt: string;
  /** Appended to the CLI's own system prompt: CREW.md plus Shipmate context. */
  appendSystemPrompt?: string;
  /** Continue this CLI session (a conversation resuming). */
  resume?: string;
  settings?: Partial<ClaudeCliSettings>;
  /**
   * MCP servers for this run, as the JSON the CLI's `--mcp-config` takes. Shipmate passes its own
   * per-turn tool server here (memory, lists, the Captain's crew tools).
   */
  mcpConfig?: string;
  /** Extra CLI settings as JSON for `--settings` (Shipmate's approval hook for MCP tools). */
  settingsJson?: string;
  /** Defaults to claudeCliBin(). */
  bin?: string;
  /** Defaults to process.env without Shipmate's own secrets (see childEnv). */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: ClaudeCliEvent) => void;
}

/** The command line for one print-mode turn. The prompt goes to stdin, never into argv. */
export function claudeCliArgs(
  options: Pick<
    ClaudeCliRunOptions,
    "appendSystemPrompt" | "resume" | "settings" | "mcpConfig" | "settingsJson"
  >,
): string[] {
  const s = options.settings ?? {};
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    s.permissionMode ?? "dontAsk",
  ];
  if (s.model) args.push("--model", s.model);
  if (s.allowedTools?.length) args.push("--allowedTools", s.allowedTools.join(","));
  if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
  if (options.mcpConfig) args.push("--mcp-config", options.mcpConfig);
  if (options.settingsJson) args.push("--settings", options.settingsJson);
  if (options.resume) args.push("--resume", options.resume);
  return args;
}

/**
 * The environment the CLI runs with: Shipmate's own environment minus its secrets (database URL,
 * vault key, bot tokens). CLAUDE_CONFIG_DIR and anything the user set for the CLI pass through.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(SHIPMATE_|DATABASE_URL$|TEST_DATABASE_URL$|DISCORD_|TELEGRAM_|SLACK_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Whether a run was paid by an API key or a Claude subscription. The CLI reports "none" when it
 * is signed in with a Claude account. When it reports nothing, runClaudeCli fills in
 * ANTHROPIC_API_KEY if that is set; otherwise the run counts as the subscription, which is what
 * this backend is for.
 */
export function claudeCliBilling(
  result: Pick<ClaudeCliResult, "apiKeySource">,
): "api" | "subscription" {
  return result.apiKeySource && result.apiKeySource !== "none" ? "api" : "subscription";
}

/** Run one turn. Resolves with the result; rejects only when the CLI cannot be started at all. */
export async function runClaudeCli(options: ClaudeCliRunOptions): Promise<ClaudeCliResult> {
  const first = await runOnce(options);
  // A resumed session the CLI no longer has (config dir reset): start a fresh one instead.
  if (
    options.resume &&
    first.isError &&
    !first.aborted &&
    !first.sessionId &&
    /no conversation found|session.*not found/i.test(first.error ?? "")
  ) {
    const { resume: _drop, ...fresh } = options;
    return runOnce(fresh);
  }
  return first;
}

function runOnce(options: ClaudeCliRunOptions): Promise<ClaudeCliResult> {
  const bin = options.bin ?? claudeCliBin();
  const emit = options.onEvent ?? (() => {});
  const result: ClaudeCliResult = {
    sessionId: null,
    text: "",
    isError: false,
    error: null,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    model: null,
    apiKeySource: null,
    aborted: false,
  };

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ ...result, aborted: true, isError: true });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(bin, claudeCliArgs(options), {
        cwd: options.cwd,
        env: options.env ?? childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so cancelling also stops the tools it started.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(isMissing(err) ? new ClaudeCliMissingError(bin) : err);
      return;
    }

    const parser = new StreamParser(emit);
    let stderr = "";
    let buffer = "";
    let gotResult = false;
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
      if (!msg) return;
      if (msg.type === "result") {
        gotResult = true;
        applyResult(result, msg);
      } else {
        parser.feed(msg);
      }
      if (parser.sessionId) result.sessionId ??= parser.sessionId;
      if (parser.model) result.model ??= parser.model;
      if (parser.apiKeySource) result.apiKeySource ??= parser.apiKeySource;
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
      if (isMissing(err)) reject(new ClaudeCliMissingError(bin));
      else reject(err);
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", kill);
      clearTimeout(killTimer);
      if (buffer.trim()) handle(buffer);
      if (!result.text) result.text = parser.text.trim();
      // A CLI that does not report its credential source uses an API key when one is set.
      const env = options.env ?? childEnv();
      if (!result.apiKeySource && env.ANTHROPIC_API_KEY?.trim()) {
        result.apiKeySource = "ANTHROPIC_API_KEY";
      }
      if (result.aborted) {
        result.isError = true;
        result.error = null;
      } else if (!gotResult) {
        result.isError = true;
        const why = stderr.trim().split("\n").slice(-5).join("\n");
        result.error =
          why ||
          `the Claude Code CLI exited ${signal ? `on ${signal}` : `with code ${code}`} without a reply`;
      }
      if (
        result.isError &&
        result.error &&
        /log ?in|logged in|auth|api key|credential/i.test(result.error)
      ) {
        result.error = `${result.error}\n\n${CLAUDE_CLI_SIGN_IN_HINT}`;
      }
      resolve(result);
    });

    child.stdin?.end(options.prompt);
  });
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

function applyResult(result: ClaudeCliResult, msg: Json) {
  if (typeof msg.session_id === "string") result.sessionId = msg.session_id;
  if (typeof msg.result === "string") result.text = msg.result.trim();
  result.costUsd = num(msg.total_cost_usd) || num(msg.cost_usd);
  const u = (msg.usage ?? {}) as Json;
  result.usage = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
  const models =
    msg.modelUsage && typeof msg.modelUsage === "object" ? Object.keys(msg.modelUsage) : [];
  if (models[0]) result.model ??= models[0];
  result.isError =
    msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype !== "success");
  if (result.isError) {
    const errors = Array.isArray(msg.errors) ? msg.errors.filter((e) => typeof e === "string") : [];
    result.error =
      (typeof msg.result === "string" && msg.result.trim()) ||
      errors.join("\n") ||
      `the Claude Code CLI stopped (${String(msg.subtype ?? "error")})`;
  }
}

/**
 * Turns stream-json messages into ClaudeCliEvents. Text arrives as partial deltas
 * (`stream_event` content_block_delta) when the CLI sends them; a text block of a complete
 * `assistant` message is emitted only if no deltas covered it.
 */
class StreamParser {
  sessionId: string | null = null;
  model: string | null = null;
  apiKeySource: string | null = null;
  text = "";
  #streamed = false;
  #toolNames = new Map<string, string>();

  constructor(private readonly emit: (e: ClaudeCliEvent) => void) {}

  feed(msg: Json) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && typeof msg.session_id === "string") {
          this.sessionId = msg.session_id;
          this.model = typeof msg.model === "string" ? msg.model : null;
          if (typeof msg.apiKeySource === "string") this.apiKeySource = msg.apiKeySource;
          this.emit({ type: "init", sessionId: msg.session_id, model: this.model });
        }
        break;
      case "stream_event": {
        if (msg.parent_tool_use_id) break; // a subagent's inner text
        const ev = (msg.event ?? {}) as Json;
        const delta = (ev.delta ?? {}) as Json;
        if (ev.type === "content_block_delta" && delta.type === "text_delta") {
          const t = typeof delta.text === "string" ? delta.text : "";
          if (t) {
            this.#streamed = true;
            this.#text(t);
          }
        }
        break;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) break;
        const content = blocks(msg.message);
        for (const b of content) {
          if (b.type === "text" && typeof b.text === "string") {
            if (!this.#streamed && b.text) this.#text(b.text);
          } else if (b.type === "tool_use" && typeof b.id === "string") {
            const name = typeof b.name === "string" ? b.name : "tool";
            this.#toolNames.set(b.id, name);
            this.emit({ type: "tool_start", id: b.id, name, input: b.input ?? {} });
          }
        }
        this.#streamed = false;
        break;
      }
      case "user": {
        for (const b of blocks(msg.message)) {
          if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const name = this.#toolNames.get(b.tool_use_id);
          if (!name) continue;
          this.#toolNames.delete(b.tool_use_id);
          this.emit({
            type: "tool_end",
            id: b.tool_use_id,
            name,
            output: b.content ?? null,
            isError: b.is_error === true,
          });
        }
        break;
      }
    }
  }

  #text(t: string) {
    this.text += t;
    this.emit({ type: "text", text: t });
  }
}

function blocks(message: unknown): Json[] {
  const content = (message as Json | null)?.content;
  return Array.isArray(content)
    ? content.filter((b): b is Json => !!b && typeof b === "object")
    : [];
}

// ---------- status ----------

export interface ClaudeCliStatus {
  installed: boolean;
  version: string | null;
  /** From `claude auth status` (its exit code and logged-in flag); credentials are never read. */
  signedIn: boolean;
  /** e.g. "oauth_token", "claude.ai", "api_key", as the CLI reports it. */
  authMethod: string | null;
  bin: string;
  configDir: string;
}

/** Ask the CLI for its version and whether it is signed in. Never opens its credential files. */
export async function claudeCliStatus(
  options: { bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ClaudeCliStatus> {
  const bin = options.bin ?? claudeCliBin(options.env);
  const env = options.env ?? childEnv();
  const base = { bin, configDir: claudeConfigDir(options.env) };
  const timeoutMs = options.timeoutMs ?? 15_000;
  const version = await capture(bin, ["--version"], env, timeoutMs);
  if (version.missing) {
    return { ...base, installed: false, version: null, signedIn: false, authMethod: null };
  }
  const auth = await capture(bin, ["auth", "status", "--json"], env, timeoutMs);
  let signedIn = auth.code === 0;
  let authMethod: string | null = null;
  const parsed = parseLine(auth.stdout.trim().replace(/\s*\n\s*/g, " "));
  if (parsed) {
    if (typeof parsed.loggedIn === "boolean") signedIn = signedIn && parsed.loggedIn;
    if (typeof parsed.authMethod === "string") authMethod = parsed.authMethod;
  }
  const v = /(\d+\.\d+\.\d+[^\s]*)/.exec(version.stdout);
  return {
    ...base,
    installed: version.code === 0 || !!v,
    version: v?.[1] ?? (version.stdout.trim() || null),
    signedIn,
    authMethod,
  };
}

function capture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      resolve({ code: null, stdout: "", missing: isMissing(err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout = (stdout + c).slice(0, 20_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, missing: isMissing(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, missing: false });
    });
  });
}
