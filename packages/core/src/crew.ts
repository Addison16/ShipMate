import { z } from "zod";

/** A model reference in `provider/model` form, e.g. `anthropic/claude-sonnet-5-5`. */
export const ModelRef = z
  .string()
  .regex(/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/, "model must look like provider/model-id");

export const ApprovalPolicy = z.union([
  z.enum(["ask", "auto"]),
  z.object({ "never-for": z.array(z.string().min(1)).min(1) }),
]);

/**
 * `crew.yaml` — the manifest of one crew member. The folder it lives in is the
 * crew member's working directory for its pi session.
 */
export const CrewManifest = z.object({
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(200),
  model: ModelRef,
  /** Built-in pi tools this crew member may use. */
  tools: z.array(z.string().min(1)).default([]),
  /** MCP server ids from the catalog or custom servers. */
  mcp: z.array(z.string().min(1)).default([]),
  /** Skill slugs, resolved against crew, user and instance scopes in that order. */
  skills: z.array(z.string().min(1)).default([]),
  approval: ApprovalPolicy.default("ask"),
  visibility: z.enum(["shared", "private"]).default("shared"),
  /** Only the coordinator (the Captain by default) has this set. */
  captain: z.boolean().default(false),
  avatar: z.string().optional(),
});
export type CrewManifest = z.infer<typeof CrewManifest>;
export type CrewManifestInput = z.input<typeof CrewManifest>;

/** Files every crew folder contains. */
export const CREW_FILES = {
  manifest: "crew.yaml",
  persona: "CREW.md",
  skillsDir: "skills",
  memoryDir: "memory",
  promptsDir: "prompts",
  sessionsDir: "sessions",
} as const;

export const CrewSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "slug must be lowercase letters, digits and dashes");
