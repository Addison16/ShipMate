import type { TaskStatus } from "./api.js";

/** A background task in one of these states has not ended yet. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "waiting"];

export function isOpenTask(status: TaskStatus): boolean {
  return OPEN_TASK_STATUSES.includes(status);
}
