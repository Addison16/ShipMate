import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { GEMINI_PROVIDER } from "@shipmate/core";
import {
  GEMINI_MODELS,
  type GeminiCliEvent,
  type GeminiCliUsage,
  geminiAuth,
  geminiHome,
  MemoryStore,
  runGeminiCli,
  splitModelRef,
} from "@shipmate/crew";
import { conversations, type Db } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { HttpError } from "./auth.js";
import { CLI_WORKDIR, type CliTurnInput, shipmateToolName } from "./claude-cli-turn.js";
import { CLI_MCP_SERVER } from "./cli-mcp.js";
import type { Billing } from "./services/usage.js";
import { summarize } from "./summarize.js";

/** Key under conversations.session_files that holds a crew member's Gemini session id. */
export const geminiSessionKey = (slug: string) => `gemini-cli:${slug}`;

export interface GeminiTurnInput extends Omit<CliTurnInput, "mcpConfig" | "settingsJson"> {
  /** Shipmate's own tools this turn (see cli-mcp.ts); none when unset. */
  mcp?: { url: string; token: string };
}

/** Models a Gemini crew member can pick (`gemini-cli/<id>`): the CLI has no list command. */
export function geminiModels(): Array<{ ref: string; name: string }> {
  return GEMINI_MODELS.map((m) => ({ ref: `${GEMINI_PROVIDER}/${m.id}`, name: m.name }));
}

/** `gemini-cli/flash` in crew.yaml → the CLI's -m; anything else → its own default. */
export function geminiModelFromRef(ref: string): string | undefined {
  const r = splitModelRef(ref);
  return r?.provider === GEMINI_PROVIDER ? r.id : undefined;
}

/**
 * A Gemini run on an API key (Shipmate's, or GEMINI_API_KEY) is billed per token. On a Google
 * login it runs on the organization's Gemini Code Assist plan. Anything else the CLI was set up
 * with by hand (such as Vertex) is billed per token too.
 */
export function geminiBilling(
  apiKey: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = geminiHome(env),
): Billing {
  return geminiAuth(env, home, apiKey).method === "login" ? "subscription" : "api";
}

/**
 * Runs turns of `gemini-cli` crew members for the Bridge (see packages/crew gemini-cli.ts).
 *
 * Approvals: Gemini's own tools run under `gemini.mode` (read-only unless the person chose
 * otherwise: its approval mode plus Shipmate's policy file) and cannot be routed through
 * Shipmate's approval cards. Shipmate's own tools reach it over MCP behind the crew member's
 * approval rules. Shipyard workspaces are not offered to it (it would run outside the Shipyard
 * sandbox).
 */
export class GeminiCliTurns {
  #running = new Map<string, Set<AbortController>>();

  constructor(
    private readonly db: Db,
    /** The API key an owner saved for the Gemini CLI, if any. */
    private readonly apiKey: () => Promise<string | null> = async () => null,
  ) {}

  /** Stop every Gemini run in this conversation (kills the processes). */
  abort(conversationId: string) {
    for (const c of this.#running.get(conversationId) ?? []) c.abort();
  }

  async turn(input: GeminiTurnInput): Promise<string> {
    const { conv, folder, emit } = input;
    if (conv.projectId) {
      throw new HttpError(
        409,
        `${folder.manifest.name} runs on Gemini CLI, which cannot work in Shipyard workspaces (it would run outside the sandbox). Pick a crew member on the Shipmate engine for project work.`,
      );
    }
    const cwd = join(folder.dir, CLI_WORKDIR);
    mkdirSync(cwd, { recursive: true });
    const key = geminiSessionKey(folder.slug);
    const resume = input.oneOff ? undefined : conv.sessionFiles[key];
    const model = geminiModelFromRef(folder.manifest.model);
    const apiKey = await this.apiKey().catch(() => null);

    const controller = new AbortController();
    const set = this.#running.get(conv.id) ?? new Set();
    set.add(controller);
    this.#running.set(conv.id, set);

    const onEvent = (e: GeminiCliEvent) => {
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
      const result = await runGeminiCli({
        cwd,
        prompt: input.prompt,
        instructions: this.#instructions(input),
        ...(resume ? { resume } : {}),
        ...(model ? { model } : {}),
        ...(input.mcp ? { mcp: input.mcp } : {}),
        apiKey,
        settings: folder.manifest.gemini ?? { mode: "read-only" },
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
      // One row per model that answered (`auto` picks per call), priced by its real id.
      const used: Array<{ id: string; usage: GeminiCliUsage }> = result.models.length
        ? result.models
        : [{ id: model ?? "default", usage: result.usage }];
      // One Gemini run can make several model calls; its wall time is the closest measure.
      const durationMs = performance.now() - startedAt;
      const billing = geminiBilling(apiKey);
      for (const m of used) {
        const u = m.usage;
        if (u.input <= 0 && u.output <= 0 && u.cacheRead <= 0) continue;
        input.record(
          input.usage,
          geminiModel(m.id),
          {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: 0,
            totalTokens: u.input + u.output + u.cacheRead,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          durationMs,
          billing,
        );
      }
      if (!result.aborted && result.isError) {
        throw new Error(result.error ?? "the Gemini CLI returned an error");
      }
      return result.text || input.stream().text.trim();
    } finally {
      set.delete(controller);
      if (!set.size) this.#running.delete(conv.id);
    }
  }

  #instructions({ user, folder, mcp, context }: GeminiTurnInput): string {
    const memory = new MemoryStore(folder.dir);
    return [
      folder.persona.trim(),
      "",
      "# Shipmate",
      "",
      `You are ${folder.manifest.name}, a crew member of a self-hosted Shipmate instance shared by several people. You are chatting, so answer in plain conversational text.`,
      `You are talking with ${user.displayName} (${user.role}). Today is ${new Date().toISOString().slice(0, 10)}.`,
      mcp
        ? `Shipmate's own tools (memory, lists and, for the Captain, the crew tools) are the \`mcp_${CLI_MCP_SERVER}_*\` tools. Use \`remember\` for durable facts worth keeping and \`recall\` to read a memory in full.`
        : "Shipmate's memory, skill and crew tools are not available in this session; the memory index below is for reference only.",
      "",
      memory.contextFor(user.id),
      ...(context?.length ? ["", ...context] : []),
    ].join("\n");
  }
}

/** Usage rows are keyed by model; Gemini turns appear as `gemini-cli/<model>` on the cost page. */
function geminiModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: GEMINI_PROVIDER,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as unknown as Model<Api>;
}
