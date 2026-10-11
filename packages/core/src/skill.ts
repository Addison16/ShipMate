import { z } from "zod";

/** Frontmatter of a SKILL.md in the Agent Skills format, plus Shipmate fields. */
export const SkillFrontmatter = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  /** Shipmate extension: who wrote it and where it applies. */
  shipmate: z
    .object({
      author: z.enum(["user", "crew"]).default("user"),
      scope: z.enum(["crew", "user", "instance"]).default("crew"),
      approved: z.boolean().default(true),
    })
    .default({ author: "user", scope: "crew", approved: true }),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;
