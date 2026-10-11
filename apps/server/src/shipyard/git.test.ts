import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeRepo,
  authHeader,
  cloneOrFetch,
  currentBranch,
  isDirty,
  pushBranch,
  redact,
} from "./git.js";

const TOKEN = "ghp_SuperSecretToken1234567890";
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).toString();

/** Every file under .git, so the token cannot hide anywhere in it. */
function gitFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(join(dir, ".git"));
  return out;
}

describe("host git with a token", () => {
  const root = mkdtempSync(join(tmpdir(), "shipmate-git-"));
  const bare = join(root, "remote.git");
  const url = `file://${bare}`;
  const work = join(root, "workspaces", "app");

  beforeAll(() => {
    const seed = join(root, "seed");
    mkdirSync(seed);
    sh(root, "init", "--bare", "-b", "main", bare);
    sh(seed, "init", "-b", "main");
    writeFileSync(join(seed, "README.md"), "hello\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-m", "first");
    sh(seed, "push", url, "main");
  });

  it("builds a basic auth header", () => {
    expect(authHeader("abc")).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:abc").toString("base64")}`,
    );
    expect(redact(`fatal: ${TOKEN} and ${B64}`, TOKEN)).toBe("fatal: *** and ***");
  });

  it("clones, fetches and pushes without the token landing in .git", async () => {
    expect(await cloneOrFetch(work, url, TOKEN)).toBe("cloned");
    expect(currentBranch(work)).toBe("main");
    expect(await isDirty(work)).toBe(false);
    writeFileSync(join(work, "new.txt"), "x\n");
    expect(await isDirty(work)).toBe(true);

    sh(work, "checkout", "-b", "fix/1-thing");
    sh(work, "add", ".");
    sh(work, "commit", "-m", "fix");
    expect(currentBranch(work)).toBe("fix/1-thing");
    await pushBranch(work, url, "fix/1-thing", TOKEN);
    expect(sh(bare, "branch", "--list")).toContain("fix/1-thing");
    expect(await cloneOrFetch(work, url, TOKEN)).toBe("fetched");

    const config = readFileSync(join(work, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(B64);
    expect(config.toLowerCase()).not.toContain("extraheader");
    expect(config).toContain(`url = ${url}`);
    for (const f of gitFiles(work)) {
      const content = readFileSync(f);
      expect(content.includes(TOKEN), f).toBe(false);
      expect(content.includes(B64), f).toBe(false);
    }
  });

  it("refuses repo config that would run code or redirect the token on the host", async () => {
    sh(work, "config", "core.hooksPath", "/tmp/evil");
    await expect(assertSafeRepo(work)).rejects.toThrow(/core\.hookspath/);
    await expect(pushBranch(work, url, "fix/1-thing", TOKEN)).rejects.toThrow(/will not run/);
    expect(await isDirty(work)).toBeNull();
    sh(work, "config", "--unset", "core.hooksPath");
    sh(work, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
    await expect(assertSafeRepo(work)).rejects.toThrow(/insteadof/);
    sh(work, "config", "--remove-section", "url.https://evil.example/");
    await expect(assertSafeRepo(work)).resolves.toBeUndefined();
  });

  it("rejects bad branch names and keeps the token out of errors", async () => {
    await expect(pushBranch(work, url, "--force", TOKEN)).rejects.toThrow(/not a valid branch/);
    const err = await pushBranch(work, `${url}-missing`, "fix/1-thing", TOKEN).catch((e) => e);
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("will not clone into a non-empty folder", async () => {
    const other = join(root, "workspaces", "busy");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "file"), "x");
    await expect(cloneOrFetch(other, url, null)).rejects.toThrow(/not empty/);
  });
});
