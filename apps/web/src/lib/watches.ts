import type { WatchDto, WatchRunDto, WatchTrigger } from "@shipmate/core";

export const CRON_PRESETS: Array<{ expression: string; label: string }> = [
  { expression: "0 7 * * 1-5", label: "Weekday mornings at 07:00" },
  { expression: "0 9 * * 1", label: "Mondays at 09:00" },
  { expression: "0 18 * * *", label: "Every day at 18:00" },
];

/** "Every 30 minutes", "Every hour", "Every 2 hours", "Every 90 minutes". */
export function describeInterval(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Interval not set";
  if (minutes === 1) return "Every minute";
  if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** A trigger in plain words. `watches` resolves the name for an "after" trigger. */
export function describeTrigger(
  trigger: WatchTrigger,
  watches: Array<Pick<WatchDto, "id" | "name">> = [],
): string {
  switch (trigger.kind) {
    case "cron": {
      const preset = CRON_PRESETS.find((p) => p.expression === trigger.expression.trim());
      const tz = trigger.timezone ? ` (${trigger.timezone})` : "";
      return preset ? `${preset.label}${tz}` : `Cron ${trigger.expression}${tz}`;
    }
    case "interval":
      return describeInterval(trigger.everyMinutes);
    case "webhook":
      return "On webhook";
    case "after": {
      const other = watches.find((w) => w.id === trigger.routineId);
      return `After ${other ? other.name : "another watch"}`;
    }
    default:
      return "Unknown trigger";
  }
}

/** "1.2s", "3m 05s", "1h 02m"; "" when not finished. */
export function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalS = Math.round(s);
  const m = Math.floor(totalS / 60);
  if (m < 60) return `${m}m ${String(totalS % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const RUN_STATUS_LABEL: Record<WatchRunDto["status"], string> = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  waiting_approval: "waiting for approval",
};

export function runTone(status: WatchRunDto["status"]): "ok" | "danger" | "warn" | "accent" {
  return status === "succeeded"
    ? "ok"
    : status === "failed"
      ? "danger"
      : status === "waiting_approval"
        ? "warn"
        : "accent";
}

/**
 * Watches an "after" trigger may point at: anything except itself and watches that (directly
 * or through a chain) run after it, which would make a loop.
 */
export function afterCandidates(watches: WatchDto[], selfId: string | null): WatchDto[] {
  if (!selfId) return watches;
  const dependsOnSelf = (w: WatchDto, seen = new Set<string>()): boolean => {
    if (w.trigger.kind !== "after") return false;
    if (w.trigger.routineId === selfId) return true;
    if (seen.has(w.id)) return false;
    seen.add(w.id);
    const parentId = w.trigger.routineId;
    const parent = watches.find((x) => x.id === parentId);
    return parent ? dependsOnSelf(parent, seen) : false;
  };
  return watches.filter((w) => w.id !== selfId && !dependsOnSelf(w));
}
