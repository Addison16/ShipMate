import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliLoginDto, CliLoginProvider } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { CliLogins, deviceCode, signInLinks } from "./cli-login.js";
import { plainText, spawnPty } from "./pty.js";

const dir = mkdtempSync(join(tmpdir(), "cli-login-"));

function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

/** Prints what `claude auth login` 2.1 prints, then checks the pasted code. */
const CLAUDE = fake(
  "claude",
  `const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write("Opening browser to sign in\\u2026\\nIf the browser didn't open, visit:\\nhttps://claude.ai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > ");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  if (c.trim() === "good#abc") { console.log("Login successful."); process.exit(0); }
  console.log("Couldn't log in: That code wasn't accepted."); process.exit(1);
});`,
);

/** Prints what `codex login --device-auth` 0.171 prints, then waits to be stopped. */
const CODEX = fake(
  "codex",
  `process.stdout.write("\\x1b[90mWelcome to Codex\\x1b[0m\\n1. Open this link in your browser and sign in to your account\\n   \\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m\\n\\n2. Enter this one-time code \\x1b[90m(expires in 15 minutes)\\x1b[0m\\n   \\x1b[94mU08D-32CER\\x1b[0m\\n");
setTimeout(() => { if (process.env.FAKE_DONE) { console.log("Successfully logged in"); process.exit(0); } }, 200);
setInterval(() => {}, 1000);`,
);

/** Like the Gemini CLI: refuses without a terminal, asks for the code, writes the login file. */
const GEMINI = fake(
  "gemini",
  `const fs = require("node:fs"), path = require("node:path");
if (!process.stdin.isTTY) { console.error("Manual authorization is required but the current session is non-interactive."); process.exit(1); }
if (process.env.GEMINI_CLI_AUTH_OVERRIDE !== "oauth-personal" || process.env.NO_BROWSER !== "true" || process.env.GEMINI_API_KEY) { console.error("wrong env"); process.exit(2); }
process.stdout.write("\\x1b[2J\\x1b[HPlease visit the following URL to authorize the application:\\n\\nhttps://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&state=s\\n\\nEnter the authorization code: ");
process.stdin.setRawMode(false);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  if (c.trim() === "good") {
    const d = path.join(process.env.GEMINI_CLI_HOME, ".gemini");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "oauth_creds.json"), "{}");
    process.stdout.write("\\nSigned in. Type your message\\n> ");
  } else process.stdout.write("\\nFailed to authenticate with authorization code:invalid_grant\\n");
});`,
);

async function until(
  logins: CliLogins,
  provider: CliLoginProvider,
  ok: (l: CliLoginDto) => boolean,
): Promise<CliLoginDto> {
  for (let i = 0; i < 100; i++) {
    const l = logins.get(provider);
    if (l && ok(l)) return l;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${JSON.stringify(logins.get(provider))}`);
}

describe("signing in the CLIs from the Providers page", () => {
  it("finds the provider's sign-in links and Codex's code, and nothing else", () => {
    const text =
      "See https://geminicli.com/docs and https://claude.ai/oauth/authorize?x=1.\n\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m";
    expect(signInLinks(text)).toEqual([
      "https://claude.ai/oauth/authorize?x=1",
      "https://auth.openai.com/codex/device",
    ]);
    expect(deviceCode("2. Enter this one-time code (expires)\n   \x1b[94mU08D-32CER\x1b[0m")).toBe(
      "U08D-32CER",
    );
    expect(deviceCode("no code here ABCD-EFGH")).toBeNull();
    expect(plainText("a\x1b[31mb\x1b[0m\r\nc\rd\x1b]0;title\x07")).toBe("ab\nc\nd");
  });

  it("Claude: shows the link, passes the pasted code, and finishes", async () => {
    const log = join(dir, "claude.log");
    const logins = new CliLogins({
      bins: { claude: CLAUDE },
      env: { ...process.env, FAKE_LOG: log },
    });
    logins.start("claude");
    const asking = await until(logins, "claude", (l) => l.asksForCode);
    expect(asking.links).toEqual(["https://claude.ai/oauth/authorize?code=true&state=abc"]);
    logins.answer("claude", " good#abc \n");
    const done = await until(logins, "claude", (l) => l.state !== "running");
    expect(done.state).toBe("done");
    expect(done.output).toContain("Login successful");
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual(["auth", "login", "--claudeai"]);
  });

  it("Claude: a wrong code fails with the CLI's own words", async () => {
    const logins = new CliLogins({
      bins: { claude: CLAUDE },
      env: { ...process.env, FAKE_LOG: join(dir, "x.log") },
    });
    logins.start("claude");
    await until(logins, "claude", (l) => l.asksForCode);
    logins.answer("claude", "bad");
    const done = await until(logins, "claude", (l) => l.state !== "running");
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/wasn't accepted/);
  });

  it("Codex: shows the device link and code; Stop ends it", async () => {
    const logins = new CliLogins({ bins: { codex: CODEX } });
    logins.start("codex");
    const l = await until(logins, "codex", (x) => !!x.code);
    expect(l.code).toBe("U08D-32CER");
    expect(l.links).toEqual(["https://auth.openai.com/codex/device"]);
    expect(l.asksForCode).toBe(false);
    logins.cancel("codex");
    expect(logins.get("codex")).toBeNull();
  });

  it("Codex: finishes on its own once signed in", async () => {
    const logins = new CliLogins({
      bins: { codex: CODEX },
      env: { ...process.env, FAKE_DONE: "1" },
    });
    logins.start("codex");
    expect((await until(logins, "codex", (l) => l.state !== "running")).state).toBe("done");
  });

  it("Gemini: runs on a terminal, takes the code, and stops once the login file appears", async () => {
    const home = join(dir, "gemini-home");
    mkdirSync(home, { recursive: true });
    const logins = new CliLogins({
      bins: { gemini: GEMINI },
      env: { ...process.env, SHIPMATE_GEMINI_HOME: home, GEMINI_API_KEY: "should-not-pass" },
    });
    logins.start("gemini");
    const asking = await until(logins, "gemini", (l) => l.asksForCode);
    expect(asking.links[0]).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    logins.answer("gemini", "good");
    const done = await until(logins, "gemini", (l) => l.state !== "running");
    expect(done.state).toBe("done");
    expect(existsSync(join(home, ".gemini", "oauth_creds.json"))).toBe(true);
    logins.close();
  });

  it("says so when the CLI is not installed", async () => {
    const logins = new CliLogins({ bins: { claude: join(dir, "nope") } });
    logins.start("claude");
    const l = await until(logins, "claude", (x) => x.state !== "running");
    expect(l.error).toMatch(/not installed/);
  });

  it("stops a sign-in nobody finishes", async () => {
    const logins = new CliLogins({ bins: { codex: CODEX }, timeoutMs: 300 });
    logins.start("codex");
    const l = await until(logins, "codex", (x) => x.state !== "running");
    expect(l.error).toMatch(/too long/);
  });
});

describe("the terminal relay", () => {
  it("runs a program on a terminal of the given size and relays keys", async () => {
    let out = "";
    const code = await new Promise<number | null>((resolve) => {
      const pty = spawnPty({
        command: "/bin/sh",
        env: { PATH: process.env.PATH },
        rows: 33,
        cols: 77,
        onData: (d) => {
          out += d;
        },
        onExit: resolve,
      });
      pty.write("stty size; test -t 0 && echo TTY; exit 3\n");
    });
    expect(code).toBe(3);
    expect(out).toContain("33 77");
    expect(out).toContain("TTY");
  });

  it("resizes", async () => {
    let out = "";
    await new Promise<void>((resolve) => {
      const pty = spawnPty({
        command: "/bin/sh",
        env: { PATH: process.env.PATH },
        onData: (d) => {
          out += d;
          if (out.includes("SIZE 50 120")) resolve();
        },
        onExit: () => resolve(),
      });
      pty.resize(50, 120);
      setTimeout(() => pty.write('echo "SIZE $(stty size)"; exit\n'), 300);
    });
    expect(out).toContain("SIZE 50 120");
  });
});
