import { mkdirSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CURSOR_PROVIDER } from "@shipmate/core";
import {
  CURSOR_FALLBACK_MODELS,
  type CursorCliEvent,
  type CursorCliImage,
  MemoryStore,
  runCursorCli,
  splitModelRef,
} from "@shipmate/crew";
import { conversations, type Db } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { HttpError } from "./auth.js";
import { CLI_WORKDIR, type CliTurnInput, shipmateToolName } from "./claude-cli-turn.js";
import { CLI_MCP_SERVER } from "./cli-mcp.js";
import type { Billing } from "./services/usage.js";
import { summarize } from "./summarize.js";

/** Key under conversations.session_files that holds a crew member's Cursor chat id. */
export const cursorSessionKey = (slug: string) => `cursor-cli:${slug}`;

export interface CursorTurnInput extends Omit<CliTurnInput, "mcpConfig" | "settingsJson"> {
  /** Shipmate's own tools this turn (see cli-mcp.ts); none when unset. */
  mcp?: { url: string; token: string };
  /** Shows a picture Cursor made on the reply (stored like a sent photo). */
  addImage?: (file: { name: string; data: Buffer }) => Promise<void>;
}

/** At most this many pictures shown per reply. */
const MAX_IMAGES = 8;

/** The last model list the signed-in CLI gave (see rememberCursorModels); null until then. */
let listed: Array<{ id: string; name: string }> | null = null;

/** Keep the models `cursor-agent models` listed, so pickers offer them without asking again. */
export function rememberCursorModels(models: Array<{ id: string; name: string }>) {
  if (models.length) listed = models;
}

/** Models a Cursor crew member can pick (`cursor/<slug>`): the CLI's list, else a short default. */
export function cursorModels(): Array<{ ref: string; name: string }> {
  return (listed ?? CURSOR_FALLBACK_MODELS).map((m) => ({
    ref: `${CURSOR_PROVIDER}/${m.id}`,
    name: m.name,
  }));
}

/** `cursor/composer-2.5` in crew.yaml → the CLI's --model; anything else → its own default. */
export function cursorModelFromRef(ref: string): string | undefined {
  const r = splitModelRef(ref);
  return r?.provider === CURSOR_PROVIDER ? r.id : undefined;
}

/**
 * A Cursor run is paid by an API key when CURSOR_API_KEY is set (the CLI then uses it ahead of a
 * login), else it runs on the signed-in account's plan.
 */
export function cursorBilling(env: NodeJS.ProcessEnv = process.env): Billing {
  return env.CURSOR_API_KEY?.trim() ? "api" : "subscription";
}

/** A picture's bytes: its saved file (relative to the workspace), else the data the CLI sent. */
export async function cursorImageFile(
  image: CursorCliImage,
  cwd: string,
  index: number,
): Promise<{ name: string; data: Buffer } | null> {
  if (image.path) {
    // Shipmate reads it with its own rights, so only a file that really is inside the workspace.
    const path = await insideFolder(
      cwd,
      isAbsolute(image.path) ? image.path : join(cwd, image.path),
    );
    const data = path ? await readFile(path).catch(() => null) : null;
    if (path && data) return { name: basename(path), data };
  }
  if (image.data) {
    const data = Buffer.from(image.data, "base64");
    if (data.length) return { name: `cursor-image-${index + 1}.png`, data };
  }
  return null;
}

/** The real path of `path` when it (after links) sits inside `folder`, else null. */
async function insideFolder(folder: string, path: string): Promise<string | null> {
  const [root, real] = await Promise.all([
    realpath(folder).catch(() => null),
    realpath(path).catch(() => null),
  ]);
  if (!root || !real) return null;
  const rel = relative(root, real);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? real : null;
}

/**
 * Runs turns of `cursor-cli` crew members for the Bridge (see packages/crew cursor-cli.ts).
 *
 * Approvals: Cursor's own tools run under the permission rules for `cursor.mode` (read-only
 * unless the person chose otherwise) and cannot be routed through Shipmate's approval cards.
 * Shipmate's own tools reach it over MCP behind the crew member's approval rules. Shipyard
 * workspaces are not offered to it (it would run outside the Shipyard sandbox).
 */
export class CursorCliTurns {
  #running = new Map<string, Set<AbortController>>();

  constructor(private readonly db: Db) {}

  /** Stop every Cursor run in this conversation (kills the processes). */
  abort(conversationId: string) {
    for (const c of this.#running.get(conversationId) ?? []) c.abort();
  }

  async turn(input: CursorTurnInput): Promise<string> {
    const { conv, folder, emit } = input;
    if (conv.projectId) {
      throw new HttpError(
        409,
        `${folder.manifest.name} runs on Cursor, which cannot work in Shipyard workspaces (it would run outside the sandbox). Pick a crew member on the Shipmate engine for project work.`,
      );
    }
    const cwd = join(folder.dir, CLI_WORKDIR);
    mkdirSync(cwd, { recursive: true });
    const key = cursorSessionKey(folder.slug);
    const resume = input.oneOff ? undefined : conv.sessionFiles[key];
    const model = cursorModelFromRef(folder.manifest.model);

    const controller = new AbortController();
    const set = this.#running.get(conv.id) ?? new Set();
    set.add(controller);
    this.#running.set(conv.id, set);

    const onEvent = (e: CursorCliEvent) => {
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

    try {
      const startedAt = performance.now();
      const result = await runCursorCli({
        cwd,
        prompt: input.prompt,
        instructions: this.#instructions(input),
        ...(resume ? { resume } : {}),
        ...(model ? { model } : {}),
        ...(input.mcp ? { mcp: input.mcp } : {}),
        settings: folder.manifest.cursor ?? { mode: "read-only" },
        // <data>/crew/<slug>: the rest of <data> stays out of reach in read-only and edit modes.
        privateRoot: dirname(dirname(folder.dir)),
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
      if (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0) {
        input.record(
          input.usage,
          cursorModel(model ?? "default"),
          {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          // One Cursor run can make several model calls; its wall time is the closest measure.
          performance.now() - startedAt,
          cursorBilling(),
        );
      }
      if (!result.aborted && result.isError) {
        throw new Error(result.error ?? "the Cursor CLI returned an error");
      }
      if (input.addImage && !result.aborted) {
        // Best effort: a picture that cannot be read or stored leaves the reply as it is.
        for (const [i, image] of result.images.slice(0, MAX_IMAGES).entries()) {
          const file = await cursorImageFile(image, cwd, i);
          if (file) await input.addImage(file).catch(() => {});
        }
      }
      return result.text || input.stream().text.trim();
    } finally {
      set.delete(controller);
      if (!set.size) this.#running.delete(conv.id);
    }
  }

  #instructions({ user, folder, mcp, context }: CursorTurnInput): string {
    const memory = new MemoryStore(folder.dir);
    return [
      folder.persona.trim(),
      "",
      "# Shipmate",
      "",
      `You are ${folder.manifest.name}, a crew member of a self-hosted Shipmate instance shared by several people. You are chatting, so answer in plain conversational text.`,
      `You are talking with ${user.displayName} (${user.role}). Today is ${new Date().toISOString().slice(0, 10)}.`,
      mcp
        ? `Shipmate's own tools (memory, lists and, for the Captain, the crew tools) are the \`${CLI_MCP_SERVER}\` MCP server's tools. Use \`remember\` for durable facts worth keeping and \`recall\` to read a memory in full.`
        : "Shipmate's memory, skill and crew tools are not available in this session; the memory index below is for reference only.",
      "",
      "To make a picture, use your built-in image generation tool. Shipmate shows the pictures you make under your reply, so do not paste their file paths.",
      "",
      memory.contextFor(user.id),
      ...(context?.length ? ["", ...context] : []),
    ].join("\n");
  }
}

/** Usage rows are keyed by model; Cursor turns appear as `cursor/<model>` on the cost page. */
function cursorModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: CURSOR_PROVIDER,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as unknown as Model<Api>;
}
