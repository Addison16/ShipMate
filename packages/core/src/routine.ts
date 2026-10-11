import { z } from "zod";

/** Routines are called "Watches" in the UI. */
export const RoutineTrigger = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1),
    timezone: z.string().optional(),
  }),
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().positive() }),
  z.object({ kind: z.literal("webhook") }),
  z.object({ kind: z.literal("github"), events: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("after"), routineId: z.string().min(1) }),
]);
export type RoutineTrigger = z.infer<typeof RoutineTrigger>;

export const RoutineSpec = z.object({
  name: z.string().min(1).max(80),
  crew: z.string().min(1),
  trigger: RoutineTrigger,
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Continue the crew member's previous session for this routine, or start fresh each run. */
  session: z.enum(["fresh", "continue"]).default("fresh"),
});
export type RoutineSpec = z.infer<typeof RoutineSpec>;

/** GitHub events a watch can run on (a "github" trigger on a Shipyard project). */
export const GITHUB_WATCH_EVENTS = [
  "issues.opened",
  "issues.labeled",
  "issue_comment",
  "pull_request.opened",
  "pull_request.merged",
  "pull_request_review",
  "ci.failed",
  "push",
] as const;
export type GitHubWatchEvent = (typeof GITHUB_WATCH_EVENTS)[number];
