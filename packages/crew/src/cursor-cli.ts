/**
 * The `cursor-cli` crew backend: runs the unmodified official Cursor CLI (`cursor-agent -p
 * --output-format stream-json`) and translates its JSON lines into the same events the Claude
 * Code backend emits.
 *
 * What this module deliberately does NOT do: read, copy, store or forward the Cursor login. The
 * user signs the CLI in themselves (`cursor-agent login` once) and the CLI keeps and refreshes its
 * own login under its HOME. Shipmate only starts the binary when someone sends a message; there is
 * no keep-alive of any kind.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { CursorCliSettings } from "@shipmate/core";
import { type ClaudeCliEvent, childEnv } from "./claude-cli.js";

/** Where the CLI keeps its login, chats and settings: its HOME (the image uses /data/cursor). */
export function cursorHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPMATE_CURSOR_HOME?.trim() || "/data/cursor";
}

/**
 * The binary Shipmate runs: `SHIPMATE_CURSOR_BIN` when set (tests, custom installs), else the copy
 * `install-cursor` put under the CLI's home (`<home>/cli/cursor-agent`), else `cursor-agent`.
 */
export function cursorCliBin(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.SHIPMATE_CURSOR_BIN?.trim();
  if (set) return set;
  const installed = join(cursorHome(env), "cli", "cursor-agent");
  return existsSync(installed) ? installed : "cursor-agent";
}

/** The command that signs the Cursor CLI in on a server (it prints a link; no browser needed). */
export const CURSOR_SIGN_IN_COMMAND =
  "docker exec -it shipmate env NO_OPEN_BROWSER=1 cursor-agent login";

/** The command that downloads the Cursor CLI into /data (it is too big to ship in the image). */
export const CURSOR_INSTALL_COMMAND = "docker exec -it shipmate install-cursor";

export const CURSOR_SIGN_IN_HINT = `Sign in once with your own Cursor account: run \`${CURSOR_SIGN_IN_COMMAND}\` and open the link it shows.`;

/** The environment variable that carries the per-turn token for Shipmate's own tools. */
export const CURSOR_MCP_TOKEN_ENV = "CURSOR_SHIPMATE_MCP_TOKEN";

/** The name of Shipmate's tool server in the CLI's mcp.json. */
const MCP_SERVER = "shipmate";

export class CursorCliMissingError extends Error {
  constructor(bin: string) {
    super(
      `The Cursor CLI (\`${bin}\`) is not installed on this server. Install it with \`${CURSOR_INSTALL_COMMAND}\`, or switch this crew member's engine to Shipmate.`,
    );
    this.name = "CursorCliMissingError";
  }
}

export type CursorCliEvent = ClaudeCliEvent;

export interface CursorCliUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A picture Cursor's image tool made: the file it saved, or its data when that is all it sent. */
export interface CursorCliImage {
  path: string | null;
  /** Base64. */
  data: string | null;
}

export interface CursorCliResult {
  /** The CLI's chat id; pass it as `resume` to continue the conversation. */
  sessionId: string | null;
  /** The final reply text. */
  text: string;
  isError: boolean;
  error: string | null;
  usage: CursorCliUsage;
  /** Pictures Cursor made this turn. */
  images: CursorCliImage[];
  aborted: boolean;
}

export interface CursorCliRunOptions {
  /** The crew member's working directory (the CLI's workspace). */
  cwd: string;
  prompt: string;
  /** CREW.md plus Shipmate context, sent ahead of the prompt (see cursorPrompt). */
  instructions?: string;
  /** Continue this Cursor chat (a conversation resuming). */
  resume?: string;
  /** The model slug (without `cursor/`); the CLI's own default when unset. */
  model?: string;
  settings?: Partial<CursorCliSettings>;
  /** Shipmate's per-turn tool server (streamable HTTP, bearer token). */
  mcp?: { url: string; token: string };
  /**
   * The folder holding Shipmate's own data (e.g. /data). In read-only and edit modes everything
   * in it except the path down to `cwd` is denied to Cursor's Read tool.
   */
  privateRoot?: string;
  /** Defaults to cursorCliBin(). */
  bin?: string;
  /** Defaults to cursorHome(). */
  home?: string;
  /** Defaults to process.env without Shipmate's own secrets. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: CursorCliEvent) => void;
}

/**
 * The command line for one turn. The prompt goes to stdin (the CLI reads it there when no prompt
 * argument is given), never into argv.
 */
export function cursorCliArgs(
  options: Pick<CursorCliRunOptions, "cwd" | "resume" | "model" | "settings" | "mcp">,
): string[] {
  const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", options.cwd];
  if (options.model) args.push("--model", options.model);
  if (options.resume) args.push("--resume", options.resume);
  // The server is Shipmate's own, written by Shipmate; its approval gate decides on each call.
  if (options.mcp) args.push("--approve-mcps");
  // Print mode writes no files without --force. Edit mode still denies the shell and .cursor/ by
  // rule (deny beats --force), so only read-only leaves it off.
  if ((options.settings?.mode ?? "read-only") !== "read-only") args.push("--force");
  return args;
}

/**
 * The CLI has no system prompt flag. The instructions go in front of the message rather than into
 * an AGENTS.md in the workspace: that folder is shared by every turn of this crew member, so two
 * people talking to it at once would race on the file, and one could get the other's memory.
 */
export function cursorPrompt(prompt: string, instructions?: string): string {
  if (!instructions?.trim()) return prompt;
  return `<shipmate-instructions>\n${instructions.trim()}\n</shipmate-instructions>\n\n${prompt}`;
}

/**
 * The permission rules for one crew member (`.cursor/cli.json` in its workspace). The CLI reads
 * that file on top of `$HOME/.cursor/cli-config.json`, its lists replacing the global ones, so
 * each crew member gets its own rules without turns of different crew members (run side by side
 * with one HOME) overwriting each other's. Deny rules win over allow rules.
 *
 * - read-only: read its folder; no writes, no shell commands.
 * - edit: also write files in its folder.
 * - anything: no rules (it runs with --force).
 *
 * In the first two, Shipmate's data next to the folder (other crew members, people's files, the
 * database, sign-ins) is denied by path, and `.cursor/sandbox.json` limits reads to the workspace.
 */
export function cursorPermissions(
  options: Pick<CursorCliRunOptions, "cwd" | "settings" | "mcp" | "privateRoot">,
): { allow: string[]; deny: string[] } {
  const mode = options.settings?.mode ?? "read-only";
  const mcp = options.mcp ? [`Mcp(${MCP_SERVER}:*)`] : [];
  if (mode === "anything") return { allow: mcp, deny: [] };
  const allow = ["Read(**)", ...(mode === "edit" ? ["Write(**)"] : []), ...mcp];
  const deny = [
    "Shell(*)",
    // Its own settings, so it cannot widen them.
    "Write(.cursor/**)",
    ...(mode === "edit" ? [] : ["Write(**)"]),
    ...(options.privateRoot ? readDenials(options.cwd, options.privateRoot) : []),
  ];
  return { allow, deny };
}

/**
 * `Read(...)` denials for everything under `root` that is not on the way down to `cwd`, so the
 * crew member reads its own folder but not the rest of Shipmate's data. Listed afresh each turn.
 */
export function readDenials(cwd: string, root: string): string[] {
  const rel = relative(root, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  const out: string[] = [];
  let dir = root;
  for (const part of rel.split(sep)) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // Not there yet: nothing to deny.
    }
    for (const name of names.sort()) {
      if (name === part) continue;
      const path = join(dir, name);
      out.push(`Read(${path})`, `Read(${path}/**)`);
    }
    dir = join(dir, part);
  }
  return out;
}

/**
 * The files Shipmate keeps in a crew member's workspace for the CLI, by path under `.cursor/`
 * (null: remove it). Their content depends only on the crew member's settings and Shipmate's
 * address, never on the person or the turn: the MCP token comes from the child's environment
 * (`${env:...}`), so turns running at once write the same bytes.
 */
export function cursorProjectFiles(
  options: Pick<CursorCliRunOptions, "cwd" | "settings" | "mcp" | "privateRoot">,
): Record<string, string | null> {
  const mode = options.settings?.mode ?? "read-only";
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    "cli.json": json({ permissions: cursorPermissions(options) }),
    // Reads outside the workspace need an approval nobody can give in a headless run.
    "sandbox.json": mode === "anything" ? null : json({ readBoundary: "workspace" }),
    "mcp.json": options.mcp
      ? json({
          mcpServers: {
            [MCP_SERVER]: {
              url: options.mcp.url,
              headers: { Authorization: `Bearer \${env:${CURSOR_MCP_TOKEN_ENV}}` },
            },
          },
        })
      : null,
  };
}

/**
 * Write the workspace's `.cursor/` files, each only when it changed and through a temporary file
 * renamed into place, so a turn starting meanwhile never reads half a file.
 */
export function writeCursorProjectFiles(cwd: string, files: Record<string, string | null>) {
  const dir = join(cwd, ".cursor");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    let now: string | null = null;
    try {
      now = readFileSync(path, "utf8");
    } catch {
      // not there
    }
    // A turn without Shipmate's tools leaves mcp.json in place: without the token it is refused.
    if (content === null) {
      if (name !== "mcp.json" && now !== null) rmSync(path, { force: true });
      continue;
    }
    if (now === content) continue;
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }
}

/** Run one turn. Resolves with the result; rejects only when the CLI cannot be started at all. */
export async function runCursorCli(options: CursorCliRunOptions): Promise<CursorCliResult> {
  writeCursorProjectFiles(options.cwd, cursorProjectFiles(options));
  const first = await runOnce(options);
  // A chat the CLI no longer has (its home reset): start a fresh one instead.
  if (
    options.resume &&
    first.isError &&
    !first.aborted &&
    /(chat|conversation|session)\b.{0,40}(not found|does not exist|unknown|invalid)|(no|unknown|invalid) (chat|conversation|session)/i.test(
      first.error ?? "",
    )
  ) {
    const { resume: _drop, ...fresh } = options;
    return runOnce(fresh);
  }
  return first;
}

function runOnce(options: CursorCliRunOptions): Promise<CursorCliResult> {
  const bin = options.bin ?? cursorCliBin();
  const emit = options.onEvent ?? (() => {});
  const result: CursorCliResult = {
    sessionId: null,
    text: "",
    isError: false,
    error: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
      // The CLI keeps its login and chats under HOME (~/.cursor, ~/.config/cursor).
      env.HOME = options.home ?? cursorHome();
      if (options.mcp) env[CURSOR_MCP_TOKEN_ENV] = options.mcp.token;
      else delete env[CURSOR_MCP_TOKEN_ENV];
      child = spawn(bin, cursorCliArgs(options), {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so cancelling also stops the commands it started.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(isMissing(err) ? new CursorCliMissingError(bin) : err);
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
      if (isMissing(err)) reject(new CursorCliMissingError(bin));
      else reject(err);
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", kill);
      clearTimeout(killTimer);
      if (buffer.trim()) handle(buffer);
      result.sessionId = parser.sessionId;
      result.text = (parser.text || parser.resultText).trim();
      result.usage = parser.usage;
      result.images = [...parser.images];
      if (result.aborted) {
        result.isError = true;
        result.error = null;
      } else if (parser.failed || !parser.completed || code) {
        result.isError = true;
        const why = stderr
          .split("\n")
          .filter((l) => l.trim())
          .slice(-5)
          .join("\n");
        result.error =
          parser.failed ??
          (why.trim() ||
            `the Cursor CLI exited ${signal ? `on ${signal}` : `with code ${code}`} without a reply`);
      }
      if (
        result.isError &&
        result.error &&
        /401|unauthori[sz]ed|log ?in|logged in|authenticat|api key|credential/i.test(result.error)
      ) {
        result.error = `${result.error}\n\n${CURSOR_SIGN_IN_HINT}`;
      }
      resolve(result);
    });

    child.stdin?.end(cursorPrompt(options.prompt, options.instructions));
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

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

/**
 * Turns `cursor-agent --output-format stream-json` lines into CursorCliEvents. Without
 * --stream-partial-output each `assistant` line is one whole message (the text between tool
 * calls), so each is one text event; tool calls come as `started` and `completed` pairs.
 */
export class EventParser {
  sessionId: string | null = null;
  text = "";
  /** The `result` line's text, used when no assistant line came. */
  resultText = "";
  usage: CursorCliUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  completed = false;
  /** The result's error, when it reported one. */
  failed: string | null = null;
  /** Pictures made with Cursor's image tool. */
  images: CursorCliImage[] = [];
  #started = new Set<string>();

  constructor(private readonly emit: (e: CursorCliEvent) => void) {}

  feed(msg: Json) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && typeof msg.session_id === "string") {
          this.sessionId = msg.session_id;
          this.emit({
            type: "init",
            sessionId: msg.session_id,
            model: typeof msg.model === "string" ? msg.model : null,
          });
        }
        break;
      case "assistant": {
        const content = obj(msg.message).content;
        const t = Array.isArray(content)
          ? content.map((c) => str(obj(c).text)).join("")
          : str(content);
        if (!t) return;
        const joined = this.text ? `\n\n${t}` : t;
        this.text += joined;
        this.emit({ type: "text", text: joined });
        break;
      }
      case "tool_call":
        this.#tool(str(msg.subtype), str(msg.call_id), obj(msg.tool_call));
        break;
      case "result": {
        this.completed = true;
        if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
        this.resultText = str(msg.result);
        if (msg.is_error === true || (msg.subtype && msg.subtype !== "success")) {
          this.failed = str(msg.result) || str(msg.error) || "the Cursor turn failed";
        }
        const u = obj(msg.usage);
        // Cursor reports input without the cached part.
        this.usage = {
          input: this.usage.input + num(u.inputTokens),
          output: this.usage.output + num(u.outputTokens),
          cacheRead: this.usage.cacheRead + num(u.cacheReadTokens),
          cacheWrite: this.usage.cacheWrite + num(u.cacheWriteTokens),
        };
        break;
      }
    }
  }

  #tool(phase: string, id: string, call: Json) {
    const [kind, body] = Object.entries(call).find(([k]) => k.endsWith("ToolCall")) ?? [];
    if (!kind || !id) return;
    const tool = toolOf(kind, obj(body));
    if (!this.#started.has(id)) {
      this.#started.add(id);
      this.emit({ type: "tool_start", id, name: tool.name, input: tool.input });
    }
    if (phase !== "completed") return;
    if (kind === "generateImageToolCall") {
      const ok = obj(obj(obj(body).result).success);
      // Only a picture the tool actually made: a failed call's requested path proves nothing.
      const path = str(ok.filePath);
      const data = str(ok.imageData);
      if (path || data) this.images.push({ path: path || null, data: data || null });
    }
    this.emit({
      type: "tool_end",
      id,
      name: tool.name,
      output: tool.output,
      isError: tool.isError,
    });
  }
}

/** A tool call's name in Shipmate's terms, its input and outcome. */
function toolOf(
  kind: string,
  body: Json,
): { name: string; input: unknown; output: unknown; isError: boolean } {
  const args = obj(body.args);
  const result = obj(body.result);
  const ok = result.success;
  const failure = result.error ?? result.failure ?? result.rejected ?? result.permissionDenied;
  const isError = !!failure;
  const outcome = (fallback: unknown) =>
    isError ? str(obj(failure).error) || str(obj(failure).message) || "failed" : fallback;
  switch (kind) {
    case "shellToolCall": {
      const s = obj(ok);
      return {
        name: "bash",
        input: { command: str(args.command) },
        output: outcome(str(s.stdout) + str(s.stderr) || str(s.output)),
        isError: isError || (s.exitCode !== undefined && num(s.exitCode) !== 0),
      };
    }
    case "editToolCall":
    case "writeToolCall":
    case "deleteToolCall":
      return {
        name: "edit",
        input: { files: [str(args.path)].filter(Boolean) },
        output: outcome(ok ? "done" : ""),
        isError,
      };
    case "readToolCall":
      return {
        name: "read",
        input: { path: str(args.path) },
        output: outcome(str(obj(ok).content)),
        isError,
      };
    case "mcpToolCall": {
      const server = str(args.providerIdentifier) || MCP_SERVER;
      const name = str(args.toolName) || str(args.name);
      return {
        name: `mcp__${server}__${name}`,
        input: args.args ?? {},
        output: outcome(obj(ok).content ?? null),
        isError: isError || obj(ok).isError === true,
      };
    }
    case "webSearchToolCall":
      return {
        name: "web_search",
        input: { query: str(args.searchTerm) },
        output: outcome(""),
        isError,
      };
    case "generateImageToolCall":
      return {
        name: "image",
        input: { description: str(args.description) },
        output: outcome("done"),
        isError,
      };
    default:
      return {
        name: kind.replace(/ToolCall$/, "").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        input: args,
        output: outcome(""),
        isError,
      };
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

/** Models offered when the CLI cannot list them (not signed in, or the list failed). */
export const CURSOR_FALLBACK_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "auto", name: "Auto" },
  { id: "composer-2.5", name: "Composer 2.5" },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
];

export interface CursorCliStatus {
  installed: boolean;
  version: string | null;
  /** From `cursor-agent status --format json`; credentials are never read. */
  signedIn: boolean;
  /** "api_key" when CURSOR_API_KEY is set, "login" when signed in with an account. */
  authMethod: "login" | "api_key" | null;
  email: string | null;
  /** From `cursor-agent models` when signed in, else CURSOR_FALLBACK_MODELS. */
  models: Array<{ id: string; name: string }>;
  bin: string;
  configDir: string;
}

/** Ask the CLI for its version, whether it is signed in and its models. Never opens its files. */
export async function cursorCliStatus(
  options: {
    bin?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    timeoutMs?: number;
    /** Also run `cursor-agent models` (slower; it asks Cursor). */
    models?: boolean;
  } = {},
): Promise<CursorCliStatus> {
  const bin = options.bin ?? cursorCliBin(options.env);
  const home = options.home ?? cursorHome(options.env);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ? childEnv(options.env) : childEnv()),
    HOME: home,
  };
  const base = { bin, configDir: home };
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fallback = CURSOR_FALLBACK_MODELS.map((m) => ({ ...m }));
  const version = await capture(bin, ["--version"], env, timeoutMs);
  if (version.missing) {
    return {
      ...base,
      installed: false,
      version: null,
      signedIn: false,
      authMethod: null,
      email: null,
      models: fallback,
    };
  }
  const status = await capture(bin, ["status", "--format", "json"], env, timeoutMs);
  let said: Json = {};
  try {
    said = obj(JSON.parse(status.output.slice(status.output.indexOf("{"))));
  } catch {
    // not JSON (older CLI): treat as signed out
  }
  const apiKey = !!env.CURSOR_API_KEY?.trim();
  const signedIn = said.isAuthenticated === true || said.status === "authenticated";
  let models = fallback;
  if (signedIn && options.models) {
    const list = await capture(bin, ["models"], env, timeoutMs);
    const parsed = list.code === 0 ? parseCursorModels(list.output) : [];
    if (parsed.length) models = parsed;
  }
  const v = /(\d{4}\.\d+\.\d+[^\s]*|\d+\.\d+\.\d+[^\s]*)/.exec(version.output);
  return {
    ...base,
    installed: version.code === 0 || !!v,
    version: v?.[1] ?? (version.output.trim() || null),
    signedIn,
    authMethod: !signedIn ? null : apiKey ? "api_key" : "login",
    email: str(obj(said.userInfo).email) || null,
    models,
  };
}

/** Terminal colour codes, which the CLI may print around model names. */
const COLOR_CODE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** `cursor-agent models` prints `<slug> - <name> (current, default)` lines. */
export function parseCursorModels(output: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const raw of output.replace(COLOR_CODE, "").split("\n")) {
    const m =
      /^\s*([A-Za-z0-9][\w.:[\]-]*)(?:\s+-\s+(.+?))?(?:\s+\((?:current|default)(?:,\s*(?:current|default))*\))?\s*$/.exec(
        raw,
      );
    if (!m?.[1] || /^(Available|Tip|No)$/i.test(m[1])) continue;
    if (out.some((x) => x.id === m[1])) continue;
    out.push({ id: m[1], name: m[2]?.trim() || m[1] });
  }
  return out;
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
