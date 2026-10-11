import type { WatchDto, WatchTrigger } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  afterCandidates,
  dailyCron,
  describeInterval,
  describeTrigger,
  formatDuration,
} from "./watches.js";

function watch(id: string, trigger: WatchTrigger): WatchDto {
  return {
    id,
    name: `Watch ${id}`,
    crewSlug: "galley",
    trigger,
    prompt: "",
    enabled: true,
    session: "fresh",
    owner: { id: "u1", name: "Addison" },
    webhookUrl: null,
    monthlyCapCents: null,
    lastRun: null,
    nextRunAt: null,
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

describe("describeTrigger", () => {
  it("names cron presets and keeps other expressions with the timezone", () => {
    expect(describeTrigger({ kind: "cron", expression: "0 7 * * 1-5" })).toBe(
      "Weekday mornings at 07:00",
    );
    expect(
      describeTrigger({ kind: "cron", expression: "*/5 * * * *", timezone: "Europe/Berlin" }),
    ).toBe("Cron */5 * * * * (Europe/Berlin)");
  });

  it("describes intervals, webhooks and after-triggers", () => {
    expect(describeTrigger({ kind: "interval", everyMinutes: 30 })).toBe("Every 30 minutes");
    expect(describeTrigger({ kind: "webhook" })).toBe("On webhook");
    expect(
      describeTrigger({ kind: "after", routineId: "a" }, [watch("a", { kind: "webhook" })]),
    ).toBe("After Watch a");
    expect(describeTrigger({ kind: "after", routineId: "zz" })).toBe("After another watch");
  });

  it("rounds intervals to hours and days", () => {
    expect(describeInterval(1)).toBe("Every minute");
    expect(describeInterval(60)).toBe("Every hour");
    expect(describeInterval(120)).toBe("Every 2 hours");
    expect(describeInterval(90)).toBe("Every 90 minutes");
    expect(describeInterval(1440)).toBe("Every day");
    expect(describeInterval(0)).toBe("Interval not set");
  });
});

describe("formatDuration", () => {
  const t0 = "2026-10-11T07:00:00.000Z";
  it("formats short and long runs", () => {
    expect(formatDuration(t0, null)).toBe("");
    expect(formatDuration(t0, "2026-10-11T07:00:00.250Z")).toBe("250ms");
    expect(formatDuration(t0, "2026-10-11T07:00:12.340Z")).toBe("12.3s");
    expect(formatDuration(t0, "2026-10-11T07:03:05.000Z")).toBe("3m 05s");
    expect(formatDuration(t0, "2026-10-11T08:02:00.000Z")).toBe("1h 02m");
  });
});

describe("afterCandidates", () => {
  it("excludes itself and watches downstream of it", () => {
    const all = [
      watch("a", { kind: "webhook" }),
      watch("b", { kind: "after", routineId: "a" }),
      watch("c", { kind: "after", routineId: "b" }),
      watch("d", { kind: "interval", everyMinutes: 5 }),
    ];
    expect(afterCandidates(all, "a").map((w) => w.id)).toEqual(["d"]);
    expect(afterCandidates(all, "c").map((w) => w.id)).toEqual(["a", "b", "d"]);
    expect(afterCandidates(all, null)).toHaveLength(4);
  });
});

describe("dailyCron", () => {
  it("turns a time of day into a daily schedule", () => {
    expect(dailyCron("07:00")).toBe("0 7 * * *");
    expect(dailyCron("6:45")).toBe("45 6 * * *");
    expect(dailyCron("24:00")).toBeNull();
    expect(dailyCron("7am")).toBeNull();
  });
});
