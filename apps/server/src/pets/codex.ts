import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_SIGN_IN_COMMAND, codexCliStatus, codexHome, runCodexCli } from "@shipmate/crew";
import { newCodexImages } from "../codex-cli-turn.js";

/**
 * Pictures on the person's ChatGPT plan: one `codex exec` run that only uses Codex's own image
 * tool (image_gen, offered when the CLI is signed in with a paid ChatGPT plan). Codex saves the
 * picture under CODEX_HOME/generated_images/<thread id>/, which is where it is read back from.
 * Shipmate never reads or sends the ChatGPT login; the CLI does all of that itself.
 */
export interface CodexPainter {
  /** Whether the CLI is signed in with a ChatGPT account (cached briefly). */
  signedIn(): Promise<boolean>;
  paint(prompt: string, transparent: boolean, signal: AbortSignal): Promise<Uint8Array>;
}

const STATUS_TTL_MS = 30_000;

export function codexPainter(dataDir: string, run: typeof runCodexCli = runCodexCli): CodexPainter {
  let status: { at: number; signedIn: Promise<boolean> } | null = null;
  const signedIn = () => {
    if (!status || Date.now() - status.at > STATUS_TTL_MS) {
      status = {
        at: Date.now(),
        signedIn: codexCliStatus()
          .then((s) => s.signedIn && s.authMethod === "chatgpt")
          .catch(() => false),
      };
    }
    return status.signedIn;
  };
  return {
    signedIn,
    async paint(prompt, transparent, signal) {
      if (!(await signedIn())) {
        status = null;
        throw new Error(
          `Codex is not signed in with ChatGPT. Run \`${CODEX_SIGN_IN_COMMAND}\` once and sign in with your ChatGPT account`,
        );
      }
      // An empty folder of its own, so the run sees nothing else.
      const cwd = join(dataDir, "codex-pictures");
      await mkdir(cwd, { recursive: true });
      const since = Date.now() - 1000;
      const result = await run({
        cwd,
        prompt: [
          "Make exactly one picture with your image generation tool, then reply with the single word: done.",
          "Do not run commands, read files or write files.",
          ...(transparent ? ["Use a transparent background."] : []),
          "",
          "The picture:",
          prompt,
        ].join("\n"),
        settings: { sandbox: "read-only" },
        signal,
      });
      if (result.aborted) throw new Error("the picture was stopped");
      if (result.isError) throw new Error(result.error ?? "Codex could not make the picture");
      const [path] = await newCodexImages({
        root: codexHome(),
        since,
        threadId: result.sessionId,
        named: result.images,
        alone: false,
      });
      if (!path) {
        throw new Error(
          "Codex did not make a picture. Its image tool needs a paid ChatGPT plan (Plus or higher)",
        );
      }
      return readFile(path);
    },
  };
}
