import { describe, expect, it } from "vitest";
import { describeSchedule } from "./starters.js";

describe("describeSchedule", () => {
  it("puts simple schedules in words", () => {
    expect(describeSchedule("0 17 * * 0")).toBe("Sundays at 17:00");
    expect(describeSchedule("30 7 * * 1-5")).toBe("Weekdays at 07:30");
    expect(describeSchedule("0 21 * * *")).toBe("Every day at 21:00");
    expect(describeSchedule("0 20 * * 0-4")).toBe("Sunday to Thursday at 20:00");
    expect(describeSchedule("0 9 * * 0,6")).toBe("Weekends at 09:00");
    expect(describeSchedule("0 8 * * 7")).toBe("Sundays at 08:00");
  });

  it("falls back to the expression for anything else", () => {
    expect(describeSchedule("*/5 * * * *")).toBe("Cron */5 * * * *");
    expect(describeSchedule("0 9 1 * *")).toBe("Cron 0 9 1 * *");
    expect(describeSchedule("0 25 * * *")).toBe("Cron 0 25 * * *");
    expect(describeSchedule("nonsense")).toBe("Cron nonsense");
  });
});
