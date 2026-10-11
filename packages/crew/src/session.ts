import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CREW_FILES } from "@shipmate/core";
import type { CrewFolder } from "./folder.js";

export interface CreateCrewSessionOptions {
  crew: CrewFolder;
  /**
   * Shared pi config directory (auth.json, models.json) for the whole instance.
   * Shipmate keeps it under /data/pi so every crew member uses the owner's providers (Q4).
   */
  agentDir: string;
  /** Reuse one runtime across sessions; created from agentDir when omitted. */
  modelRuntime?: ModelRuntime;
  /** Continue the most recent session in this crew member's folder instead of starting fresh. */
  continueRecent?: boolean;
  /** Keep the session out of disk storage (tests, one-off routines). */
  inMemory?: boolean;
  /** Extra text appended to the system prompt, e.g. who is speaking and shared memory. */
  appendSystemPrompt?: string[];
}

export interface CrewSession {
  session: AgentSession;
  crew: CrewFolder;
  /** Stream events (text deltas, tool calls, settled) to a UI or bridge. */
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  dispose: () => void;
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

  const [providerId, ...rest] = crew.manifest.model.split("/");
  const modelId = rest.join("/");
  const model = providerId ? modelRuntime.getModel(providerId, modelId) : undefined;
  if (!model) throw new Error(`crew ${crew.slug}: model ${crew.manifest.model} is not configured`);

  const resourceLoader = new DefaultResourceLoader({
    cwd: crew.dir,
    agentDir,
    additionalSkillPaths: [join(crew.dir, CREW_FILES.skillsDir)],
    additionalPromptTemplatePaths: [join(crew.dir, CREW_FILES.promptsDir)],
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
    ? SessionManager.inMemory(crew.dir)
    : options.continueRecent
      ? SessionManager.continueRecent(crew.dir, sessionDir)
      : SessionManager.create(crew.dir, sessionDir);

  const { session } = await createAgentSession({
    cwd: crew.dir,
    agentDir,
    modelRuntime,
    model,
    ...(crew.manifest.tools.length ? { tools: crew.manifest.tools } : {}),
    resourceLoader,
    sessionManager,
  });

  return {
    session,
    crew,
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text) => session.prompt(text),
    dispose: () => session.dispose(),
  };
}
