import { chmod, lchown, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CODEX_SANDBOX_ERROR,
  type CodexCliResult,
  type CodexCliRunOptions,
  childEnv,
  codexHome,
  codexSandboxWorks,
  runCodexCli,
} from "@shipmate/crew";

/**
 * Runs the Codex CLI for Shipmate, also on hosts where Codex's own sandbox cannot start.
 *
 * Codex sandboxes itself with bubblewrap, which needs user namespaces. Docker's default security
 * profile refuses them, so in most Shipmate containers every Codex turn failed with "bwrap: No
 * permissions to create a new namespace". There Shipmate runs Codex without its sandbox but as
 * its own unprivileged Linux user (SHIPMATE_CLI_UID/GID, set by the image), so the container's
 * file permissions keep it out of Shipmate's data instead:
 * - Codex's home (CODEX_HOME) belongs to that user;
 * - the crew member's folder belongs to it only when the crew member may edit files;
 * - Shipmate's private folders under /data are closed to other users;
 * - the built-in database only takes connections from root and postgres (docker/entrypoint.sh).
 */

let sandboxCheck: Promise<boolean> | undefined;

/** Whether Codex's own sandbox works here (checked once per server start). */
export function codexSandboxAvailable(): Promise<boolean> {
  sandboxCheck ??= codexSandboxWorks().catch(() => true);
  return sandboxCheck;
}

/** For tests. */
export function setCodexSandboxAvailable(works: boolean | undefined) {
  sandboxCheck = works === undefined ? undefined : Promise.resolve(works);
}

/** Folders under the data folder that only Shipmate reads (secrets, sign-ins, people's files). */
const PRIVATE_DIRS = ["pi", "claude", "cursor", "gemini", "mcp", "files", "backups"];

export class CodexUnsandboxedError extends Error {
  constructor() {
    super(
      "Codex's sandbox cannot start in this container, and Shipmate has no separate user to run it as. Use the Shipmate image, or set SHIPMATE_CLI_UID and SHIPMATE_CLI_GID to an unprivileged user.",
    );
    this.name = "CodexUnsandboxedError";
  }
}

/** The Linux user the image made for running CLIs without their sandbox; null when unset. */
export function cliUser(env: NodeJS.ProcessEnv = process.env): { uid: number; gid: number } | null {
  const uid = Number(env.SHIPMATE_CLI_UID);
  const gid = Number(env.SHIPMATE_CLI_GID ?? env.SHIPMATE_CLI_UID);
  return Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0 ? { uid, gid } : null;
}

/**
 * Run one Codex turn. `write` says whether the crew member may change files in `cwd`. Falls back
 * to the unsandboxed run (see above) when Codex's sandbox is unavailable, including when the
 * sandbox check passed but the run itself hit the namespace error.
 */
export async function runCodex(
  options: CodexCliRunOptions,
  write: boolean,
): Promise<CodexCliResult> {
  if (await codexSandboxAvailable()) {
    const result = await runCodexCli(options);
    if (!result.isError || !CODEX_SANDBOX_ERROR.test(result.error ?? "")) return result;
    sandboxCheck = Promise.resolve(false);
  }
  return runCodexCli({ ...options, ...(await unsandboxed(options.cwd, write)) });
}

async function unsandboxed(
  cwd: string,
  write: boolean,
): Promise<Pick<CodexCliRunOptions, "unsandboxed" | "runAs" | "env">> {
  const root = process.getuid?.() === 0;
  // Not root (a desktop install): Codex runs as that person anyway, like running it by hand.
  if (!root) return { unsandboxed: true };
  const user = cliUser();
  if (!user) throw new CodexUnsandboxedError();
  const home = codexHome();
  await closePrivateDirs();
  // `docker exec ... codex login` and Shipmate's status checks run as root and leave root's files.
  await own(home, user);
  // Shipmate (root) still writes the folder; only Codex's write access changes.
  await own(cwd, write ? user : { uid: 0, gid: 0 });
  return {
    unsandboxed: true,
    runAs: user,
    // root's home is closed to that user; Codex and the tools it runs want a writable one.
    env: { ...childEnv(), HOME: home },
  };
}

let closed = false;

async function closePrivateDirs() {
  if (closed) return;
  const data = process.env.SHIPMATE_DATA_DIR?.trim() || "/data";
  for (const name of PRIVATE_DIRS) {
    const dir = join(data, name);
    const s = await lstat(dir).catch(() => null);
    if (s?.isDirectory() && s.uid === 0) await chmod(dir, s.mode & 0o700).catch(() => {});
  }
  closed = true;
}

/** chown -R, touching only what someone else owns. Symlinks are not followed. */
async function own(dir: string, user: { uid: number; gid: number }) {
  const walk = async (path: string, depth: number) => {
    const s = await lstat(path).catch(() => null);
    if (!s) return;
    if (s.uid !== user.uid || s.gid !== user.gid) {
      await lchown(path, user.uid, user.gid).catch(() => {});
    }
    if (!s.isDirectory() || depth > 12) return;
    for (const name of await readdir(path).catch(() => [])) await walk(join(path, name), depth + 1);
  };
  await walk(dir, 0);
}
