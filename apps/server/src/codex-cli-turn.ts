import { mkdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { CODEX_PROVIDER } from "@shipmate/core";
import {
  type CodexCliEvent,
  codexCliStatus,
  codexHome,
  MemoryStore,
  runCodexCli,
  splitModelRef,
} from "@shipmate/crew";
import { conversations, type Db } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { HttpError } from "./auth.js";
import { CLI_WORKDIR, type CliTurnInput, shipmateToolName } from "./claude-cli-turn.js";
import { CLI_MCP_SERVER } from "./cli-mcp.js";
import { planModelIds } from "./services/chatgpt.js";
import type { Billing } from "./services/usage.js";
import { summarize } from "./summarize.js";

/** Key under conversations.session_files that holds a crew member's Codex thread id. */
export const codexSessionKey = (slug: string) => `codex-cli:${slug}`;

export interface CodexTurnInput extends Omit<CliTurnInput, "mcpConfig" | "settingsJson"> {
  /** Shipmate's own tools this turn (see cli-mcp.ts); none when unset. */
  mcp?: { url: string; token: string };
  /** Shows a picture Codex made on the reply (stored like a sent photo). */
  addImage?: (file: { name: string; data: Buffer }) => Promise<void>;
}

/** Where Codex's built-in image tool saves pictures (under CODEX_HOME). */
export const CODEX_IMAGES_DIR = "generated_images";
/** At most this many pictures shown per reply. */
const MAX_IMAGES = 8;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Pictures Codex saved during a turn: the ones its events name, else new files under
 * CODEX_HOME/generated_images. A file found only by time is taken when its path names this
 * thread, or when no other Codex turn ran meanwhile, so one person never gets another's picture.
 */
export async function newCodexImages(options: {
  root: string;
  since: number;
  threadId: string | null;
  named: string[];
  alone: boolean;
}): Promise<string[]> {
  if (options.named.length) return options.named.slice(0, MAX_IMAGES);
  const found: Array<{ path: string; at: number }> = [];
  const walk = async (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(path, depth + 1);
      else if (e.isFile() && IMAGE_FILE.test(e.name)) {
        const s = await stat(path).catch(() => null);
        if (s && s.mtimeMs >= options.since) found.push({ path, at: s.mtimeMs });
      }
    }
  };
  await walk(join(options.root, CODEX_IMAGES_DIR), 0);
  found.sort((a, b) => a.at - b.at);
  const mine = options.threadId
    ? found.filter((f) => f.path.includes(options.threadId as string))
    : [];
  const picked = mine.length ? mine : options.alone ? found : [];
  return picked.slice(0, MAX_IMAGES).map((f) => f.path);
}

/** Models a Codex crew member can pick (`codex/<id>`), newest first: what a ChatGPT plan runs. */
export function codexModels(): Array<{ ref: string; name: string }> {
  const names = new Map(
    openaiProvider()
      .getModels()
      .map((m) => [m.id, m.name]),
  );
  return planModelIds().map((id) => ({
    ref: `${CODEX_PROVIDER}/${id}`,
    name: names.get(id) ?? id,
  }));
}

/** `codex/gpt-6.1-sol` in crew.yaml → the CLI's --model; anything else → its own default. */
export function codexModelFromRef(ref: string): string | undefined {
  const r = splitModelRef(ref);
  return r?.provider === CODEX_PROVIDER ? r.id : undefined;
}

/**
 * Runs turns of `codex-cli` crew members for the Bridge (see packages/crew codex-cli.ts).
 *
 * Approvals: Codex's own commands run in its sandbox (`codex.sandbox`, read-only unless the
 * person chose otherwise) and cannot be routed through Shipmate's approval cards. Shipmate's own
 * tools reach it over MCP behind the crew member's approval rules. Shipyard workspaces are not
 * offered to it (it would run outside the Shipyard sandbox).
 */
export class CodexCliTurns {
  #running = new Map<string, Set<AbortController>>();
  /** Turns started since the server started, to tell whether another ran alongside one. */
  #started = 0;
  #active = 0;

  constructor(private readonly db: Db) {}

  /** Stop every Codex run in this conversation (kills the processes). */
  abort(conversationId: string) {
    for (const c of this.#running.get(conversationId) ?? []) c.abort();
  }

  async turn(input: CodexTurnInput): Promise<string> {
    const { conv, folder, emit } = input;
    if (conv.projectId) {
      throw new HttpError(
        409,
        `${folder.manifest.name} runs on Codex, which cannot work in Shipyard workspaces (it would run outside the sandbox). Pick a crew member on the Shipmate engine for project work.`,
      );
    }
    const cwd = join(folder.dir, CLI_WORKDIR);
    mkdirSync(cwd, { recursive: true });
    const key = codexSessionKey(folder.slug);
    const resume = input.oneOff ? undefined : conv.sessionFiles[key];
    const model = codexModelFromRef(folder.manifest.model);

    const controller = new AbortController();
    const set = this.#running.get(conv.id) ?? new Set();
    set.add(controller);
    this.#running.set(conv.id, set);

    const onEvent = (e: CodexCliEvent) => {
      const stream = input.stream();
      if (e.type === "tool_start" || e.type === "tool_end") {
        const name = shipmateToolName(e.name);
        // Hand-offs show as their own bubbles.
        if (name === "delegate" || name === "ask_captain" || name === "ask_person") return;
        e = { ...e, name };
      }
      switch (e.type) {
        case "text":
          stream.text += e.text;
          emit({ type: "delta", conversationId: conv.id, streamId: stream.id, text: e.text });
          break;
        case "tool_start":
          stream.tools.push(e.name);
          emit({
            type: "tool",
            conversationId: conv.id,
            streamId: stream.id,
            phase: "start",
            toolCallId: e.id,
            toolName: e.name,
            summary: summarize(e.input),
          });
          break;
        case "tool_end":
          emit({
            type: "tool",
            conversationId: conv.id,
            streamId: stream.id,
            phase: "end",
            toolCallId: e.id,
            toolName: e.name,
            summary: summarize(typeof e.output === "string" ? e.output : { content: e.output }),
            isError: e.isError,
          });
          break;
        case "init":
          break;
      }
    };

    const startedNo = ++this.#started;
    this.#active++;
    const aloneAtStart = this.#active === 1;
    const since = Date.now() - 1000;
    try {
      const startedAt = performance.now();
      // A ChatGPT sign-in runs on the plan; an API key is billed per token like any API call.
      const billing = codexCliStatus()
        .then((s): Billing => (s.authMethod === "chatgpt" ? "subscription" : "api"))
        .catch((): Billing => "api");
      const result = await runCodexCli({
        cwd,
        prompt: input.prompt,
        instructions: this.#instructions(input),
        ...(resume ? { resume } : {}),
        ...(model ? { model } : {}),
        ...(input.mcp ? { mcp: input.mcp } : {}),
        settings: folder.manifest.codex ?? { sandbox: "read-only" },
        signal: controller.signal,
        onEvent,
      });

      if (!input.oneOff && result.sessionId && result.sessionId !== resume) {
        conv.sessionFiles = { ...conv.sessionFiles, [key]: result.sessionId };
        await this.db
          .update(conversations)
          .set({ sessionFiles: conv.sessionFiles })
          .where(eq(conversations.id, conv.id));
      }
      const u = result.usage;
      if (u.input > 0 || u.output > 0 || u.cacheRead > 0) {
        input.record(
          input.usage,
          codexModel(model ?? "default"),
          {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: 0,
            totalTokens: u.input + u.output + u.cacheRead,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          // One Codex run can make several model calls; its wall time is the closest measure.
          performance.now() - startedAt,
          await billing,
        );
      }
      if (!result.aborted && result.isError) {
        throw new Error(result.error ?? "the Codex CLI returned an error");
      }
      if (input.addImage && !result.aborted) {
        const images = await newCodexImages({
          root: codexHome(),
          since,
          threadId: result.sessionId,
          named: result.images,
          alone: aloneAtStart && this.#started === startedNo,
        });
        for (const path of images) {
          const data = await readFile(path).catch(() => null);
          // A picture that cannot be stored (too big, odd format) leaves the reply as it is.
          if (data) await input.addImage({ name: basename(path), data }).catch(() => {});
        }
      }
      return result.text || input.stream().text.trim();
    } finally {
      this.#active--;
      set.delete(controller);
      if (!set.size) this.#running.delete(conv.id);
    }
  }

  #instructions({ user, folder, mcp, context }: CodexTurnInput): string {
    const memory = new MemoryStore(folder.dir);
    return [
      folder.persona.trim(),
      "",
      "# Shipmate",
      "",
      `You are ${folder.manifest.name}, a crew member of a self-hosted Shipmate instance shared by several people. You are chatting, so answer in plain conversational text.`,
      `You are talking with ${user.displayName} (${user.role}). Today is ${new Date().toISOString().slice(0, 10)}.`,
      mcp
        ? `Shipmate's own tools (memory, lists and, for the Captain, the crew tools) are the \`mcp__${CLI_MCP_SERVER}__*\` tools. Use \`remember\` for durable facts worth keeping and \`recall\` to read a memory in full.`
        : "Shipmate's memory, skill and crew tools are not available in this session; the memory index below is for reference only.",
      "",
      "To make a picture, use your built-in image generation tool. Shipmate shows the pictures you make under your reply, so do not paste their file paths.",
      "",
      memory.contextFor(user.id),
      ...(context?.length ? ["", ...context] : []),
    ].join("\n");
  }
}

/** Usage rows are keyed by model; Codex turns appear as `codex/<model>` on the cost page. */
function codexModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: CODEX_PROVIDER,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as unknown as Model<Api>;
}
