import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliLoginDto, CliLoginProvider } from "@shipmate/core";
import { childEnv, claudeCliBin, codexCliBin, geminiCliBin, geminiHome } from "@shipmate/crew";
import { type Pty, plainText, spawnPty } from "./pty.js";

/**
 * "Sign in" on the Providers page: runs each CLI's own official login command on the server and
 * shows the person what it prints (the sign-in link, a one-time code) so nobody needs
 * `docker exec`. The person signs in on the provider's own site; the CLI keeps the login in its
 * own folder, as it does when run by hand. Shipmate never reads, stores or forwards the login,
 * and nothing here runs on a schedule.
 *
 * - Claude: `claude auth login --claudeai` prints a link and reads the code the page shows.
 * - Codex: `codex login --device-auth` prints a link and a code to type there; it finishes alone.
 * - Gemini: the CLI's Google sign-in only runs on a terminal, so it gets one (pty.ts). It prints
 *   a link and asks for the code; Shipmate stops it once the login file appears.
 */

/** A sign-in that nobody finishes is stopped after this long (the codes expire sooner). */
export const CLI_LOGIN_TIMEOUT_MS = 15 * 60_000;

/** Only links to the providers' own sign-in pages are shown as buttons. */
const SIGN_IN_HOSTS = [
  "claude.ai",
  "claude.com",
  "anthropic.com",
  "auth.openai.com",
  "chatgpt.com",
  "accounts.google.com",
];

export function signInLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of plainText(text).matchAll(/https:\/\/[^\s"'<>`]+/g)) {
    const raw = m[0].replace(/[.,;)\]]+$/, "");
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      continue;
    }
    if (!SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** Codex's one-time device code, e.g. "U08D-32CER". */
export function deviceCode(text: string): string | null {
  const plain = plainText(text);
  const at = plain.search(/one-time code|enter this code|user code/i);
  if (at < 0) return null;
  return /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(plain.slice(at))?.[1] ?? null;
}

const ASKS_FOR_CODE: Record<CliLoginProvider, RegExp | null> = {
  claude: /paste code/i,
  codex: null,
  gemini: /authorization code/i,
};

interface Running {
  dto: CliLoginDto;
  raw: string;
  write: (text: string) => void;
  stop: () => void;
  timer: NodeJS.Timeout;
  /** Gemini: how often Shipmate looks for the login file. */
  poll?: NodeJS.Timeout;
}

export interface CliLoginOptions {
  env?: NodeJS.ProcessEnv;
  /** For tests. */
  bins?: Partial<Record<CliLoginProvider, string>>;
  python?: string;
  timeoutMs?: number;
}

export class CliLogins {
  private readonly runs = new Map<CliLoginProvider, Running>();

  constructor(private readonly options: CliLoginOptions = {}) {}

  get(provider: CliLoginProvider): CliLoginDto | null {
    const run = this.runs.get(provider);
    return run ? { ...run.dto, output: tail(plainText(run.raw)) } : null;
  }

  /** Start (or restart) a sign-in. */
  start(provider: CliLoginProvider): CliLoginDto {
    this.cancel(provider);
    const env = this.options.env ?? process.env;
    const dto: CliLoginDto = {
      provider,
      state: "running",
      links: [],
      code: null,
      asksForCode: false,
      output: "",
      error: null,
      startedAt: new Date().toISOString(),
    };
    const run: Running = {
      dto,
      raw: "",
      write: () => {},
      stop: () => {},
      timer: setTimeout(() => {
        this.finish(run, "failed", "The sign-in took too long. Start it again.");
        run.stop();
      }, this.options.timeoutMs ?? CLI_LOGIN_TIMEOUT_MS),
    };
    run.timer.unref?.();
    this.runs.set(provider, run);

    const onData = (text: string) => {
      run.raw = (run.raw + text).slice(-50_000);
      // Output arrives in pieces that can split a link or a prompt, so read what has arrived so
      // far, and links only from finished lines (a link is always followed by a line break).
      const end = Math.max(run.raw.lastIndexOf("\n"), run.raw.lastIndexOf("\r"));
      for (const link of signInLinks(run.raw.slice(0, end + 1))) {
        if (!dto.links.includes(link)) dto.links.push(link);
      }
      if (provider === "codex") dto.code ??= deviceCode(run.raw);
      const ask = ASKS_FOR_CODE[provider];
      if (ask?.test(plainText(run.raw.slice(-4_000)))) dto.asksForCode = true;
    };
    const onExit = (code: number | null) => {
      if (dto.state !== "running") return;
      if (code === 0) this.finish(run, "done", null);
      else this.finish(run, "failed", lastLine(plainText(run.raw)) || "The sign-in stopped.");
    };
    const onError = (err: Error) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      this.finish(
        run,
        "failed",
        missing ? "This app is not installed on the server." : `Could not start: ${err.message}`,
      );
    };

    const bin = (p: CliLoginProvider, fallback: string) => this.options.bins?.[p] ?? fallback;
    if (provider === "gemini") {
      const home = geminiHome(env);
      const loginFile = join(home, ".gemini", "oauth_creds.json");
      const before = mtime(loginFile);
      const cwd = join(tmpdir(), "shipmate-gemini-login");
      mkdirSync(cwd, { recursive: true });
      const genv: NodeJS.ProcessEnv = {
        ...childEnv(env),
        GEMINI_CLI_HOME: home,
        GEMINI_CLI_TRUST_WORKSPACE: "true",
        GEMINI_CLI_AUTH_OVERRIDE: "oauth-personal",
        NO_BROWSER: "true",
      };
      delete genv.GEMINI_API_KEY;
      const pty: Pty = spawnPty({
        command: bin("gemini", geminiCliBin(env)),
        cwd,
        env: genv,
        rows: 40,
        // Wide, so the long sign-in link is never cut by a line break.
        cols: 1000,
        onData,
        onExit,
        onError,
        ...(this.options.python ? { python: this.options.python } : {}),
      });
      run.write = (t) => pty.write(`${t}\r`);
      run.stop = () => pty.kill();
      // The CLI stays open after signing in (it is the chat app), so stop it once the login
      // file is new.
      run.poll = setInterval(() => {
        const now = mtime(loginFile);
        if (now !== null && now !== before) {
          this.finish(run, "done", null);
          pty.kill();
        }
      }, 1_000);
      run.poll.unref?.();
    } else {
      const [command, args] =
        provider === "claude"
          ? [bin("claude", claudeCliBin(env)), ["auth", "login", "--claudeai"]]
          : [bin("codex", codexCliBin(env)), ["login", "--device-auth"]];
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          env: childEnv(env),
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (err) {
        onError(err as Error);
        return this.get(provider) as CliLoginDto;
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", onData);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", onData);
      child.stdin?.on("error", () => {});
      child.on("error", onError);
      child.on("close", onExit);
      run.write = (t) => child.stdin?.write(`${t}\n`);
      run.stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      };
    }
    return this.get(provider) as CliLoginDto;
  }

  /** Pass the code from the sign-in page to the CLI. */
  answer(provider: CliLoginProvider, text: string): CliLoginDto | null {
    const run = this.runs.get(provider);
    if (run?.dto.state !== "running") return this.get(provider);
    const code = text.replace(/[\r\n]+/g, "").trim();
    // It stays asking: a code the CLI refuses gets a new try (its reply shows in the output).
    if (code) run.write(code);
    return this.get(provider);
  }

  cancel(provider: CliLoginProvider): void {
    const run = this.runs.get(provider);
    if (!run) return;
    if (run.dto.state === "running") this.finish(run, "cancelled", null);
    run.stop();
    this.runs.delete(provider);
  }

  close(): void {
    for (const p of [...this.runs.keys()]) this.cancel(p);
  }

  private finish(run: Running, state: CliLoginDto["state"], error: string | null) {
    if (run.dto.state !== "running") return;
    run.dto.state = state;
    run.dto.error = error;
    run.dto.asksForCode = false;
    clearTimeout(run.timer);
    if (run.poll) clearInterval(run.poll);
  }
}

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function tail(text: string): string {
  return text.length > 4_000 ? text.slice(-4_000) : text;
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}
