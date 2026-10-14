import { z } from "zod";

/**
 * crew.yaml `model: default`: use the crew default picked in Settings, and follow it when it
 * changes. New crew start on it; a person can still give one crew member its own model.
 */
export const DEFAULT_MODEL = "default";

/**
 * A model reference in `provider/model` form, e.g. `anthropic/claude-sonnet-5-5`, or
 * {@link DEFAULT_MODEL}.
 */
export const ModelRef = z
  .string()
  .regex(
    /^(default|[a-z0-9-]+\/[A-Za-z0-9._:-]+)$/,
    'model must look like provider/model-id, or be "default"',
  );

export const ApprovalPolicy = z.union([
  z.enum(["ask", "auto"]),
  z.object({ "never-for": z.array(z.string().min(1)).min(1) }),
]);

/**
 * What runs a crew member's turns: `pi` (default; Shipmate's own agent with the instance's
 * providers), `claude-code-cli` (the unmodified official `claude` binary, signed in by the user
 * with their own Claude subscription), `codex-cli` (the unmodified official `codex` binary,
 * signed in by the user with their own ChatGPT plan) or `cursor-cli` (the unmodified official
 * `cursor-agent` binary, signed in by the user with their own Cursor plan). Shipmate never
 * touches any CLI's credentials (§11/§12).
 */
export const CrewBackend = z.enum(["pi", "claude-code-cli", "codex-cli", "cursor-cli"]);
export type CrewBackend = z.infer<typeof CrewBackend>;

/** Settings for the `claude-code-cli` backend (ignored by `pi`). */
export const ClaudeCliSettings = z.object({
  /** Passed to `claude --model`: an alias (sonnet, opus, haiku) or a full model name. */
  model: z
    .string()
    .regex(/^[A-Za-z0-9._[\]-]{1,100}$/, "cli.model must be a model alias or name")
    .optional(),
  /** Tools the CLI may use without asking (`--allowedTools`), e.g. Read, Edit, "Bash(git *)". */
  allowedTools: z.array(z.string().min(1).max(200)).default([]),
  /**
   * `--permission-mode`. `dontAsk` (default) refuses every tool call not in allowedTools, since
   * nobody can answer the CLI's own prompts; `acceptEdits` also lets it edit files in its folder;
   * `plan` keeps it read-only; `bypassPermissions` allows every tool without asking.
   */
  permissionMode: z
    .enum(["dontAsk", "acceptEdits", "plan", "bypassPermissions"])
    .default("dontAsk"),
});
export type ClaudeCliSettings = z.infer<typeof ClaudeCliSettings>;

/** Picture files a pet can be, in the crew member's `pet/` folder. */
export const PET_IMAGE_FILE = /^pet\.(png|webp|jpg|svg)$/;

/**
 * An optional pet: a small creature that hangs out next to the crew member in chat and dances
 * while they work. Off until someone makes one with the Captain (or turns it back on).
 */
export const CrewPet = z.object({
  enabled: z.boolean().default(false),
  name: z.string().min(1).max(40).optional(),
  /** One sentence describing it, kept so the Captain can redraw it. */
  look: z.string().max(400).optional(),
  /** The picture in `pet/`, e.g. pet.png or pet.svg. */
  image: z
    .string()
    .regex(PET_IMAGE_FILE, "pet.image must be pet.png, pet.webp, pet.jpg or pet.svg")
    .optional(),
});
export type CrewPet = z.infer<typeof CrewPet>;

/** Settings for the `codex-cli` backend (ignored by the others). The model is `codex/<id>`. */
export const CodexCliSettings = z.object({
  /**
   * `codex exec --sandbox`. `read-only` (default) lets it read and run read-only commands in its
   * folder; `workspace-write` also lets it change files there; `danger-full-access` lifts the
   * sandbox (it still runs inside Shipmate's container).
   */
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
});
export type CodexCliSettings = z.infer<typeof CodexCliSettings>;

/** The provider id Codex models use in crew.yaml (`codex/gpt-6.1-sol`). */
export const CODEX_PROVIDER = "codex";

/** Settings for the `cursor-cli` backend (ignored by the others). The model is `cursor/<slug>`. */
export const CursorCliSettings = z.object({
  /**
   * What the Cursor agent may do, set through its permission rules. `read-only` (default) lets it
   * read files in its folder; `edit` also lets it change files there; `anything` runs it with
   * `--force` (every tool, any command; it still runs inside Shipmate's container).
   */
  mode: z.enum(["read-only", "edit", "anything"]).default("read-only"),
});
export type CursorCliSettings = z.infer<typeof CursorCliSettings>;

/** The provider id Cursor models use in crew.yaml (`cursor/composer-2.5`). */
export const CURSOR_PROVIDER = "cursor";

/**
 * `crew.yaml` — the manifest of one crew member. The folder it lives in is the
 * crew member's working directory for its pi session.
 */
export const CrewManifest = z.object({
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(200),
  model: ModelRef,
  /** What runs this crew member's turns (see CrewBackend). */
  backend: CrewBackend.default("pi"),
  /** Options for the claude-code-cli backend. */
  cli: ClaudeCliSettings.optional(),
  /** Options for the codex-cli backend. */
  codex: CodexCliSettings.optional(),
  /** Options for the cursor-cli backend. */
  cursor: CursorCliSettings.optional(),
  /** Built-in pi tools this crew member may use. */
  tools: z.array(z.string().min(1)).default([]),
  /** MCP server ids from the catalog or custom servers. */
  mcp: z.array(z.string().min(1)).default([]),
  /** Skill slugs, resolved against crew, user and instance scopes in that order. */
  skills: z.array(z.string().min(1)).default([]),
  approval: ApprovalPolicy.default("ask"),
  /** Tools this crew member may run without asking, added by "always allow" on an approval. */
  allow: z.array(z.string().min(1)).default([]),
  /**
   * Let it start helper agents: short-lived copies of itself that work on part of a task and
   * report back. On pi this adds the `helper` tool; on Claude Code it allows Claude Code's own
   * sub agent tool. Helpers spend from the same caps.
   */
  helpers: z.boolean().default(false),
  /** Load skills this crew member writes without waiting for a person to approve them. */
  autoApproveSkills: z.boolean().default(false),
  /** Monthly spend ceiling for this crew member in USD (all people together); null = none. */
  monthlyCapUsd: z.number().positive().nullable().default(null),
  visibility: z.enum(["shared", "private"]).default("shared"),
  /** Only the coordinator (the Captain by default) has this set. */
  captain: z.boolean().default(false),
  avatar: z.string().optional(),
  pet: CrewPet.optional(),
});
export type CrewManifest = z.infer<typeof CrewManifest>;
export type CrewManifestInput = z.input<typeof CrewManifest>;

/** Files every crew folder contains. */
export const CREW_FILES = {
  manifest: "crew.yaml",
  persona: "CREW.md",
  skillsDir: "skills",
  /** Bot-made skills awaiting approval; pi does not load these. */
  pendingSkillsDir: "skills-pending",
  memoryDir: "memory",
  promptsDir: "prompts",
  sessionsDir: "sessions",
  /** The pet picture and the drafts made while building it. */
  petDir: "pet",
} as const;

export const CrewSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "slug must be lowercase letters, digits and dashes");
