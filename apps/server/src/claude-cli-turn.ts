import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { CODEX_PROVIDER, DEFAULT_MODEL, type ServerEvent } from "@shipmate/core";
import {
  type ClaudeCliEvent,
  type CrewFolder,
  claudeCliBilling,
  MemoryStore,
  runClaudeCli,
  splitModelRef,
} from "@shipmate/crew";
import { conversations, type Db } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { HttpError, type UserRow } from "./auth.js";
import { CLI_MCP_SERVER } from "./cli-mcp.js";
import type { Billing, UsageContext } from "./services/usage.js";
import { summarize } from "./summarize.js";

type ConversationRow = typeof conversations.$inferSelect;

/** Key under conversations.session_files that holds a crew member's CLI session id. */
export const cliSessionKey = (slug: string) => `claude-cli:${slug}`;

/** The folder the CLI works in, inside the crew folder but away from memory/ and sessions/. */
export const CLI_WORKDIR = "cli-workspace";

/** The Bridge's open reply bubble (structurally the same as its own Stream). */
export interface CliStream {
  id: string;
  text: string;
  tools: string[];
}

export interface CliTurnInput {
  user: UserRow;
  conv: ConversationRow;
  folder: CrewFolder;
  prompt: string;
  /**
   * The open reply bubble. A getter: when the Captain delegates, the Bridge closes its bubble
   * and opens a fresh one for the rest of the Captain's answer.
   */
  stream: () => CliStream;
  usage: UsageContext;
  /** `--mcp-config` for Shipmate's own tools this turn (see cli-mcp.ts); none when unset. */
  mcpConfig?: string;
  /** `--settings` JSON: the approval hook for the crew member's installed MCP servers. */
  settingsJson?: string;
  /** Extra system prompt sections (the Captain's crew roster, how to answer a consult). */
  context?: string[];
  /** A one-off answer (the Captain answering a crew question): no resume, nothing stored. */
  oneOff?: boolean;
  emit: (event: ServerEvent) => void;
  /** The Bridge's usage writer: the turn waits for it before ending (cap checks stay exact). */
  record: (
    ctx: UsageContext,
    model: Model<Api>,
    usage: Usage,
    durationMs?: number,
    billing?: Billing,
  ) => void;
}

/**
 * Runs turns of `claude-code-cli` crew members for the Bridge (see packages/crew claude-cli.ts).
 *
 * Approvals: the CLI's own tool calls cannot be routed through Shipmate's approval cards, so the
 * crew member's `cli.permissionMode` (default `dontAsk`) and `cli.allowedTools` decide what it may
 * do; with the defaults, anything beyond reading files in its own folder is refused. Caps are
 * checked by the Bridge before the turn, and the CLI's reported cost is recorded afterwards like
 * any other turn. Shipyard workspaces are not offered to it (it would run outside the sandbox).
 */
export class ClaudeCliTurns {
  #running = new Map<string, Set<AbortController>>();

  constructor(private readonly db: Db) {}

  /** Stop every CLI run in this conversation (kills the processes). */
  abort(conversationId: string) {
    for (const c of this.#running.get(conversationId) ?? []) c.abort();
  }

  isRunning(conversationId: string): boolean {
    return (this.#running.get(conversationId)?.size ?? 0) > 0;
  }

  async turn(input: CliTurnInput): Promise<string> {
    const { conv, folder, emit } = input;
    if (conv.projectId) {
      throw new HttpError(
        409,
        `${folder.manifest.name} runs on the Claude Code CLI, which cannot work in Shipyard workspaces (it would run outside the sandbox). Pick a crew member on the pi backend for project work.`,
      );
    }
    const cwd = join(folder.dir, CLI_WORKDIR);
    mkdirSync(cwd, { recursive: true });
    const key = cliSessionKey(folder.slug);
    const resume = input.oneOff ? undefined : conv.sessionFiles[key];
    const own = folder.manifest.cli ?? {
      allowedTools: [],
      permissionMode: "dontAsk" as const,
    };
    const settings = {
      ...own,
      allowedTools: cliAllowedTools(
        folder.dir,
        own.allowedTools,
        input.mcpConfig !== undefined,
        folder.manifest.helpers,
      ),
    };
    const model = settings.model ?? cliModelFromRef(folder.manifest.model);

    const controller = new AbortController();
    const set = this.#running.get(conv.id) ?? new Set();
    set.add(controller);
    this.#running.set(conv.id, set);

    let needBreak = false;
    let streamed = false;
    const onEvent = (e: ClaudeCliEvent) => {
      const stream = input.stream();
      // Hand-offs show as their own bubbles; Shipmate's tools show under their plain names.
      if (e.type === "tool_start" || e.type === "tool_end") {
        const name = shipmateToolName(e.name);
        if (name === "delegate" || name === "ask_captain" || name === "ask_person") return;
        e = { ...e, name };
      }
      switch (e.type) {
        case "text": {
          let text = e.text;
          if (needBreak && stream.text && !stream.text.endsWith("\n\n")) {
            text = `${stream.text.endsWith("\n") ? "\n" : "\n\n"}${text}`;
          }
          needBreak = false;
          streamed = true;
          stream.text += text;
          emit({ type: "delta", conversationId: conv.id, streamId: stream.id, text });
          break;
        }
        case "tool_start":
          needBreak = true;
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
      const result = await runClaudeCli({
        cwd,
        prompt: input.prompt,
        appendSystemPrompt: this.#systemPrompt(input),
        ...(resume ? { resume } : {}),
        ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
        ...(input.settingsJson ? { settingsJson: input.settingsJson } : {}),
        settings: { ...settings, ...(model ? { model } : {}) },
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
      if (result.costUsd > 0 || result.usage.input > 0 || result.usage.output > 0) {
        input.record(
          input.usage,
          cliModel(result.model ?? model ?? "default"),
          cliUsage(result.usage, result.costUsd),
          // One CLI run can make several model calls; its wall time is the closest measure.
          performance.now() - startedAt,
          // On a subscription the CLI's cost is what the run would have cost at API prices.
          claudeCliBilling(result),
        );
      }
      if (!result.aborted && result.isError) {
        throw new Error(result.error ?? "the Claude Code CLI returned an error");
      }
      // Partial-message streaming is off on some CLI versions; fall back to the final text.
      const stream = input.stream();
      if (!streamed && !stream.text.trim() && result.text) {
        stream.text = result.text;
        emit({ type: "delta", conversationId: conv.id, streamId: stream.id, text: result.text });
      }
      return result.text || stream.text.trim();
    } finally {
      set.delete(controller);
      if (!set.size) this.#running.delete(conv.id);
    }
  }

  #systemPrompt({ user, folder, mcpConfig, context }: CliTurnInput): string {
    const memory = new MemoryStore(folder.dir);
    return [
      folder.persona.trim(),
      "",
      "# Shipmate",
      "",
      `You are ${folder.manifest.name}, a crew member of a self-hosted Shipmate instance shared by several people.`,
      `You are talking with ${user.displayName} (${user.role}). Today is ${new Date().toISOString().slice(0, 10)}.`,
      mcpConfig
        ? `Shipmate's own tools (memory, lists and, for the Captain, the crew tools) are the \`mcp__${CLI_MCP_SERVER}__*\` tools. Use \`remember\` for durable facts worth keeping and \`recall\` to read a memory in full.`
        : "Shipmate's memory, skill and crew tools are not available in this session; the memory index below is for reference only.",
      "",
      memory.contextFor(user.id),
      ...(context?.length ? ["", ...context] : []),
    ].join("\n");
  }
}

/**
 * Tools every CLI crew member may use without asking, on top of its own `cli.allowedTools`:
 * reading (and Glob/Grep, which follow Read rules) inside its working folder, and looking things
 * up on the web. In `dontAsk` mode anything else is refused, so without these a fresh crew member
 * cannot even read its own files. The rest of the crew folder stays out of reach: memory/ holds
 * each person's private memories, which it reaches only through the user-scoped memory tools.
 */
export function defaultCliTools(crewDir: string): string[] {
  // `//` starts an absolute path in Claude Code permission rules.
  const abs = `${crewDir}/${CLI_WORKDIR}`.replace(/\\/g, "/").replace(/^\/*/, "");
  return [`Read(//${abs}/**)`, "WebSearch", "WebFetch"];
}

/**
 * Claude Code's sub agent tool, for crew with `helpers: true`. It was called Task and is now
 * Agent; both are allowed so either version of the CLI works. Sub agents get the same rules.
 */
export const CLI_HELPER_TOOLS = ["Task", "Agent"];

/**
 * The `--allowedTools` for a turn: the defaults, the crew member's own, its sub agent tool when
 * helpers are on, and Shipmate's tools.
 */
export function cliAllowedTools(
  crewDir: string,
  own: string[],
  shipmateTools: boolean,
  helpers = false,
): string[] {
  return [
    ...new Set([
      ...defaultCliTools(crewDir),
      ...own,
      ...(helpers ? CLI_HELPER_TOOLS : []),
      // Shipmate's tools go through its own approval policy, so the CLI may call them all.
      ...(shipmateTools ? [`mcp__${CLI_MCP_SERVER}`] : []),
    ]),
  ];
}

/** `mcp__shipmate__delegate` → `delegate`; other tool names unchanged. */
export function shipmateToolName(name: string): string {
  const prefix = `mcp__${CLI_MCP_SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * A crew member set to the crew default runs where the default does. With the Claude
 * subscription as the default (`claude-code/<alias>`), it runs on the Claude Code CLI with that
 * model, and with a Codex model (`codex/<id>`) on the Codex CLI; a CLI crew member on the default takes a Claude default's model. Anything else is as is.
 */
export function onCrewDefault(folder: CrewFolder, defaultModel: string): CrewFolder {
  const m = folder.manifest;
  if (m.model !== DEFAULT_MODEL) return folder;
  const provider = splitModelRef(defaultModel)?.provider;
  if (provider === "claude-code") {
    return { ...folder, manifest: { ...m, backend: "claude-code-cli", model: defaultModel } };
  }
  if (provider === CODEX_PROVIDER) {
    return { ...folder, manifest: { ...m, backend: "codex-cli", model: defaultModel } };
  }
  if (m.backend === "claude-code-cli" && provider === "anthropic") {
    return { ...folder, manifest: { ...m, model: defaultModel } };
  }
  return folder;
}

/** `claude-code/sonnet` or `anthropic/claude-…` in crew.yaml → the CLI's --model; else its default. */
export function cliModelFromRef(ref: string): string | undefined {
  const r = splitModelRef(ref);
  if (!r) return undefined;
  return r.provider === "claude-code" || r.provider === "anthropic" ? r.id : undefined;
}

/** Usage rows are keyed by model; CLI turns appear as `claude-code/<model>` on the cost page. */
function cliModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "claude-code",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as unknown as Model<Api>;
}

function cliUsage(
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
  costUsd: number,
): Usage {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
  };
}
