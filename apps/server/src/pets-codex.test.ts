import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexCliRunOptions, runCodexCli } from "@shipmate/crew";
import { describe, expect, it } from "vitest";
import { codexPainter } from "./pets/codex.js";

const dir = mkdtempSync(join(tmpdir(), "shipmate-codex-pictures-"));
const home = join(dir, "codex");
const env = { ...process.env };

/** Like `codex exec`: a picture lands under CODEX_HOME/generated_images/<thread id>/. */
function fakeRun(thread: string, picture: boolean, calls: CodexCliRunOptions[]) {
  return (async (options: CodexCliRunOptions) => {
    calls.push(options);
    if (picture) {
      mkdirSync(join(home, "generated_images", thread), { recursive: true });
      writeFileSync(join(home, "generated_images", thread, "call_1.png"), "png bytes");
    }
    return {
      sessionId: thread,
      text: "done",
      isError: false,
      error: null,
      usage: { input: 1, output: 1, cacheRead: 0 },
      images: [],
      aborted: false,
    };
  }) as typeof runCodexCli;
}

describe("pictures through Codex", () => {
  it("runs Codex read-only in its own folder and returns the picture it saved", async () => {
    process.env.CODEX_HOME = home;
    // A Codex that is signed in with ChatGPT.
    process.env.SHIPMATE_CODEX_BIN = join(dir, "codex-bin");
    writeFileSync(
      process.env.SHIPMATE_CODEX_BIN,
      '#!/bin/sh\n[ "$1" = "--version" ] && echo "codex-cli 9.9.9" && exit 0\necho "Logged in using ChatGPT" >&2\n',
      { mode: 0o755 },
    );
    try {
      const calls: CodexCliRunOptions[] = [];
      const painter = codexPainter(dir, fakeRun("thread-a", true, calls));
      expect(await painter.signedIn()).toBe(true);
      const bytes = await painter.paint("a red sailboat", true, new AbortController().signal);
      expect(Buffer.from(bytes).toString()).toBe("png bytes");
      expect(calls[0]).toMatchObject({
        cwd: join(dir, "codex-pictures"),
        settings: { sandbox: "read-only" },
      });
      expect(calls[0]?.prompt).toContain("image generation tool");
      expect(calls[0]?.prompt).toContain("transparent background");
      expect(calls[0]?.prompt).toContain("a red sailboat");

      // No picture (a Free plan has no image tool): a plain reason, not a silent failure.
      const none = codexPainter(dir, fakeRun("thread-b", false, []));
      await expect(none.paint("a boat", false, new AbortController().signal)).rejects.toThrow(
        /paid ChatGPT plan/,
      );
    } finally {
      process.env = env;
    }
  });

  it("says how to sign in when Codex is not signed in with ChatGPT", async () => {
    process.env.SHIPMATE_CODEX_BIN = join(dir, "codex-out");
    writeFileSync(
      process.env.SHIPMATE_CODEX_BIN,
      '#!/bin/sh\n[ "$1" = "--version" ] && echo "codex-cli 9.9.9" && exit 0\necho "Not logged in" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    try {
      const calls: CodexCliRunOptions[] = [];
      const painter = codexPainter(dir, fakeRun("thread-c", true, calls));
      expect(await painter.signedIn()).toBe(false);
      await expect(painter.paint("a boat", false, new AbortController().signal)).rejects.toThrow(
        /codex login --device-auth/,
      );
      expect(calls).toHaveLength(0);
    } finally {
      process.env = env;
    }
  });
});
