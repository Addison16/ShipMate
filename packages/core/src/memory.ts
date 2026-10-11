import { z } from "zod";

/**
 * One memory file: frontmatter plus a body, one fact per file. Crew memory lives in
 * `memory/shared/` (everyone) and `memory/users/<userId>/` (one person), each with a MEMORY.md
 * index, so the Captain remembers who asked for what without leaking it to others.
 */
export const MemoryFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "name must be a short kebab-case slug"),
  description: z.string().min(1).max(200),
  type: z.enum(["user", "feedback", "project", "reference"]).default("project"),
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatter>;

export const MEMORY_INDEX = "MEMORY.md";
