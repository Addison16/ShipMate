import type { HealthCheckDto, HealthStatus } from "@shipmate/core";

/** Badge tone per check status. */
export const STATUS_TONE = { ok: "ok", warn: "warn", fail: "danger" } as const;
export const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "ok",
  warn: "warning",
  fail: "problem",
};

/** The page's headline: worst first. */
export function summarize(checks: HealthCheckDto[]): {
  status: HealthStatus;
  label: string;
} {
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  if (fail) {
    return {
      status: "fail",
      label: `${fail} problem${fail === 1 ? "" : "s"}${warn ? `, ${warn} warning${warn === 1 ? "" : "s"}` : ""}`,
    };
  }
  if (warn)
    return { status: "warn", label: `All working, ${warn} warning${warn === 1 ? "" : "s"}` };
  return { status: "ok", label: "All good" };
}

/** Checks grouped in the order the server lists them. */
export function groupChecks(checks: HealthCheckDto[]): Array<[string, HealthCheckDto[]]> {
  const groups = new Map<string, HealthCheckDto[]>();
  for (const c of checks) {
    const list = groups.get(c.group);
    if (list) list.push(c);
    else groups.set(c.group, [c]);
  }
  return [...groups];
}

/**
 * After an update starts, Shipmate goes away and comes back. Poll until the version changes, or
 * it is back (or never left) with the same version, or give up.
 */
export type UpdateProgress = "waiting" | "restarting" | "updated" | "unchanged" | "timeout";

export function nextProgress(
  state: { sawDown: boolean; startedAt: number },
  result: { version: string } | null,
  current: string,
  now: number,
  timeoutMs = 5 * 60_000,
  /** Up the whole time this long: the helper found nothing newer and left Shipmate running. */
  neverDownMs = 3 * 60_000,
): UpdateProgress {
  if (result && result.version !== current) return "updated";
  if (result && (state.sawDown || now - state.startedAt > neverDownMs)) return "unchanged";
  if (now - state.startedAt > timeoutMs) return "timeout";
  return result ? "waiting" : "restarting";
}
