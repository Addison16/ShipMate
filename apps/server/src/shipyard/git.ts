import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Host-side git for Shipyard workspaces. The token is handed to one git command at a time as
 * command-scoped config (an `http.<url>.extraheader`), so it never lands in .git/config, a
 * remote URL, the sandbox or a log.
 *
 * The sandbox can write anything in the workspace, .git included, so before running git on the
 * host we refuse repo config that could run commands or redirect the token (hooks, fsmonitor,
 * url rewrites, includes, alternates and the like), and we always push and fetch to an
 * explicit URL rather than whatever `origin` says.
 */

export class GitError extends Error {}

const TIMEOUT_MS = 10 * 60_000;

/** Config keys a sandbox may leave in .git/config that are harmless to host-side git. */
const SAFE_CONFIG = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath)$/,
  /^remote\.[^.]+\.(url|fetch)$/,
  /^branch\.[^.]+(\.[^.]+)*\.(remote|merge|rebase)$/,
  /^user\.(name|email)$/,
  /^extensions\.objectformat$/,
  /^(init\.defaultbranch|pull\.rebase|pull\.ff|push\.autosetupremote|push\.default)$/,
  /^(advice|color)\./,
];

/** Overrides that beat repo config: no hooks, no fsmonitor, no helpers, no proxies. */
const HARDENING = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.sshCommand=",
  "credential.helper=",
  "protocol.ext.allow=never",
  "gc.auto=0",
  "maintenance.auto=false",
];

export function authHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

interface RunOptions {
  cwd?: string;
  /** The remote this command talks to; the auth header is scoped to it. */
  url?: string;
  token?: string | null;
}

/** Run git with a clean environment; the token travels as command-scoped config only. */
export function git(args: string[], options: RunOptions = {}): Promise<string> {
  const config = [...HARDENING];
  if (options.cwd) config.push(`safe.directory=${options.cwd}`);
  if (options.token && options.url) {
    const scope = /^https?:\/\//.test(options.url) ? `http.${originOf(options.url)}/` : "http.";
    config.push(`${scope}.extraheader=${authHeader(options.token)}`);
  }
  // GIT_CONFIG_COUNT/KEY/VALUE is the env form of `-c`: scoped to this process, and not
  // visible in the process list the way argv is.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach((c, i) => {
    const eq = c.indexOf("=");
    env[`GIT_CONFIG_KEY_${i}`] = c.slice(0, eq);
    env[`GIT_CONFIG_VALUE_${i}`] = c.slice(eq + 1);
  });
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env,
        timeout: TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = redact(`${stderr}`.trim() || err.message, options.token);
          reject(new GitError(`git ${args[0]} failed: ${detail}`));
          return;
        }
        resolve(redact(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), options.token));
      },
    );
  });
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

/** Remove the token (and its base64 header form) from text that may be shown to anyone. */
export function redact(text: string, token: string | null | undefined): string {
  if (!token) return text;
  let out = text.split(token).join("***");
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  out = out.split(b64).join("***");
  return out;
}

export function isCloned(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Refuse a workspace whose .git could make host-side git run code or leak the token. Throws a
 * GitError naming what to remove (from inside the sandbox).
 */
export async function assertSafeRepo(dir: string): Promise<void> {
  const dotGit = join(dir, ".git");
  const st = lstatSync(dotGit);
  if (!st.isDirectory()) throw new GitError(".git must be a plain directory in the workspace");
  for (const f of ["config", "HEAD"]) {
    const p = join(dotGit, f);
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
      throw new GitError(`.git/${f} must not be a symlink`);
    }
  }
  if (existsSync(join(dotGit, "commondir"))) throw new GitError(".git/commondir is not supported");
  if (existsSync(join(dotGit, "objects", "info", "alternates"))) {
    throw new GitError(".git/objects/info/alternates is not allowed in a Shipyard workspace");
  }
  const keys = (
    await git(["config", "--local", "--no-includes", "--name-only", "--list"], { cwd: dir })
  )
    .split("\n")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const bad = [...new Set(keys.filter((k) => !SAFE_CONFIG.some((re) => re.test(k))))];
  if (bad.length) {
    throw new GitError(
      `.git/config has settings Shipmate will not run on the host: ${bad.join(", ")}. Remove them (git config --unset) from inside the sandbox.`,
    );
  }
}

/** Clone into `dir` (which may exist but must be empty), or fetch when already cloned. */
export async function cloneOrFetch(
  dir: string,
  url: string,
  token: string | null,
): Promise<"cloned" | "fetched"> {
  if (isCloned(dir)) {
    await assertSafeRepo(dir);
    await git(["fetch", "--prune", url, "+refs/heads/*:refs/remotes/origin/*"], {
      cwd: dir,
      url,
      token,
    });
    return "fetched";
  }
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length) {
    throw new GitError("the workspace folder is not empty and is not a git repository");
  }
  await git(["clone", "--", url, dir], { url, token });
  return "cloned";
}

/** The checked-out branch, read from .git/HEAD; null when detached or not a repo. */
export function currentBranch(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Uncommitted changes; null when unknown (not cloned, or the repo is not safe to inspect). */
export async function isDirty(dir: string): Promise<boolean | null> {
  if (!isCloned(dir)) return null;
  try {
    await assertSafeRepo(dir);
    const out = await git(["status", "--porcelain", "--untracked-files=normal"], { cwd: dir });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

/** The remote's default branch as recorded by clone (refs/remotes/origin/HEAD). */
export async function remoteDefaultBranch(dir: string): Promise<string | null> {
  try {
    const out = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir });
    return out.replace(/^origin\//, "").trim() || null;
  } catch {
    return null;
  }
}

export async function validBranchName(name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  try {
    await git(["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
}

/** Push one branch to an explicit URL (never force). */
export async function pushBranch(
  dir: string,
  url: string,
  branch: string,
  token: string | null,
): Promise<string> {
  if (!(await validBranchName(branch)))
    throw new GitError(`"${branch}" is not a valid branch name`);
  await assertSafeRepo(dir);
  return git(["push", "--porcelain", url, `refs/heads/${branch}:refs/heads/${branch}`], {
    cwd: dir,
    url,
    token,
  });
}
