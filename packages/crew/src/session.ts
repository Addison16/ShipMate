import { join } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type BashOperations,
  createAgentSession,
  createBashToolDefinition,
  createMcpExtension,
  DefaultResourceLoader,
  type InlineExtension,
  type McpServerConfig,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { CREW_FILES } from "@shipmate/core";
import { type ApprovalHost, approvalExtension } from "./approval.js";
import type { CrewFolder } from "./folder.js";
import { guardExtension } from "./guard.js";

export interface CreateCrewSessionOptions {
  crew: CrewFolder;
  /**
   * Shared pi config directory (auth.json, models.json) for the whole instance.
   * Shipmate keeps it under /data/pi so every crew member uses the owner's providers (Q4).
   */
  agentDir: string;
  /** Reuse one runtime across sessions; created from agentDir when omitted. */
  modelRuntime?: ModelRuntime;
  /** Use this model instead of resolving crew.yaml's (e.g. a fallback when that has no key). */
  model?: Model<Api>;
  /** Continue the most recent session in this crew member's folder instead of starting fresh. */
  continueRecent?: boolean;
  /** Reopen this pi session file (a conversation resuming). Takes precedence over continueRecent. */
  sessionFile?: string;
  /** Keep the session out of disk storage (tests, one-off routines). */
  inMemory?: boolean;
  /** Extra text appended to the system prompt, e.g. who is speaking and their memory. */
  appendSystemPrompt?: string[];
  /** Shipmate tools (memory, crew management, delegation); always enabled. */
  customTools?: ToolDefinition[];
  /** MCP servers this crew member may use, already resolved from the catalog and the vault. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Keep file tools inside the crew folder (default on); see guard.ts. */
  guard?: boolean;
  /** Approval gates and audit (§13); without a host every tool call runs unasked. */
  approvals?: () => ApprovalHost;
  /** Instance- and user-wide skill folders to load besides the crew's own (readable, not writable). */
  skillPaths?: string[];
  /**
   * Work in a project workspace instead of the crew folder: file tools are confined to `dir`,
   * and the shell runs through `bash` (a sandbox container), never on the Shipmate host.
   */
  workspace?: { dir: string; bash: BashOperations };
}

export interface CrewSession {
  session: AgentSession;
  crew: CrewFolder;
  model: Model<Api>;
  /** Stream events (text deltas, tool calls, settled) to a UI or bridge. */
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  /** `images` go with the text as image content (the model must accept images). */
  prompt: (text: string, images?: ImageContent[]) => Promise<void>;
  abort: () => Promise<void>;
  sessionFile: string | undefined;
  dispose: () => void;
}

/** Split `provider/model-id` (the model id itself may contain slashes, e.g. OpenRouter). */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

/**
 * One crew member = one pi AgentSession rooted at the crew folder.
 * pi discovers skills and prompt templates in that folder; CREW.md is injected as the
 * project context file, so the on-disk layout is the configuration.
 */
export async function createCrewSession(options: CreateCrewSessionOptions): Promise<CrewSession> {
  const { crew, agentDir } = options;
  const modelRuntime =
    options.modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    }));

  let model = options.model;
  if (!model) {
    const ref = splitModelRef(crew.manifest.model);
    model = ref ? modelRuntime.getModel(ref.provider, ref.id) : undefined;
  }
  if (!model) throw new Error(`crew ${crew.slug}: model ${crew.manifest.model} is not configured`);

  const extensionFactories: InlineExtension[] = [];
  const skillPaths = options.skillPaths ?? [];
  const workspace = options.workspace;
  const cwd = workspace?.dir ?? crew.dir;
  if (options.guard !== false) {
    extensionFactories.push({
      name: "shipmate-guard",
      factory: guardExtension({
        root: cwd,
        // In a workspace the crew member can still read its own folder (skills, prompts).
        readable: workspace ? [crew.dir, ...skillPaths] : skillPaths,
      }),
    });
  }
  if (options.approvals) {
    extensionFactories.push({
      name: "shipmate-approvals",
      factory: approvalExtension({ manifest: crew.manifest, host: options.approvals }),
    });
  }
  const mcpServers = Object.entries(options.mcpServers ?? {});
  if (mcpServers.length) {
    extensionFactories.push({
      name: "shipmate-mcp",
      factory: createMcpExtension({
        loadConfig: () => ({
          servers: mcpServers.map(([name, config]) => ({ name, config, source: "shipmate" })),
          autoEnableCodemode: false,
          errors: [],
        }),
        logPath: join(agentDir, "mcp.log"),
        startupWaitMs: 5000,
      }),
    });
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: [join(crew.dir, CREW_FILES.skillsDir), ...skillPaths],
    additionalPromptTemplatePaths: [join(crew.dir, CREW_FILES.promptsDir)],
    extensionFactories,
    // Built-in MCP reads ~/.pi mcp.json; Shipmate supplies its own servers per crew member.
    disabledBuiltinExtensions: ["mcp"],
    agentsFilesOverride: () => ({
      agentsFiles: crew.persona
        ? [{ path: join(crew.dir, CREW_FILES.persona), content: crew.persona }]
        : [],
    }),
    ...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
  });
  await resourceLoader.reload();

  const sessionDir = join(crew.dir, CREW_FILES.sessionsDir);
  const sessionManager = options.inMemory
    ? SessionManager.inMemory(cwd)
    : options.sessionFile
      ? SessionManager.open(options.sessionFile, sessionDir, cwd)
      : options.continueRecent
        ? SessionManager.continueRecent(cwd, sessionDir)
        : SessionManager.create(cwd, sessionDir);

  const customTools = [
    ...(options.customTools ?? []),
    // Replaces pi's built-in bash, so commands go to the sandbox.
    ...(workspace
      ? [createBashToolDefinition(cwd, { operations: workspace.bash }) as unknown as ToolDefinition]
      : []),
  ];
  // An explicit tool list is an allowlist, so Shipmate's own tools and MCP tools are added to it.
  const tools = crew.manifest.tools.length
    ? [
        ...crew.manifest.tools,
        ...customTools.map((t) => t.name),
        ...(mcpServers.length ? ["mcp__*"] : []),
      ]
    : undefined;

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    ...(tools ? { tools } : {}),
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({}),
  });
  if (mcpServers.length) await session.bindExtensions({});

  return {
    session,
    crew,
    model,
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text, images) => session.prompt(text, images?.length ? { images } : undefined),
    abort: () => session.abort(),
    get sessionFile() {
      return sessionManager.getSessionFile();
    },
    dispose: () => session.dispose(),
  };
}
