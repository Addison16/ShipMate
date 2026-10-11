import type { DiscordStatusDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { discordState, formatCountdown, isSnowflake, secondsLeft } from "./discord.js";

const base: DiscordStatusDto = {
  configured: true,
  connected: true,
  applicationId: "1",
  guildId: "123456789012345678",
  guildName: "Home",
  error: null,
  inviteUrl: null,
  channels: [],
};

describe("countdown", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  it("formats minutes and seconds, rounding up", () => {
    expect(formatCountdown("2026-10-11T12:04:05.000Z", now)).toBe("4:05");
    expect(formatCountdown("2026-10-11T12:00:08.200Z", now)).toBe("0:09");
    expect(formatCountdown("2026-10-11T13:02:03.000Z", now)).toBe("1:02:03");
  });

  it("says expired at or after the deadline and for bad input", () => {
    expect(formatCountdown("2026-10-11T12:00:00.000Z", now)).toBe("expired");
    expect(formatCountdown("2026-10-11T11:00:00.000Z", now)).toBe("expired");
    expect(secondsLeft("not a date", now)).toBe(0);
  });
});

describe("discordState", () => {
  it("covers not set up, connected and broken", () => {
    expect(discordState({ ...base, configured: false, connected: false }).label).toBe("not set up");
    expect(discordState(base).detail).toContain("Home");
    expect(discordState({ ...base, guildName: null, guildId: null }).detail).toMatch(/guild/);
    const broken = discordState({ ...base, connected: false, error: "Token rejected." });
    expect(broken).toMatchObject({ tone: "danger", detail: "Token rejected." });
    expect(discordState({ ...base, connected: false }).tone).toBe("warn");
  });
});

describe("isSnowflake", () => {
  it("accepts 17-20 digit ids only", () => {
    expect(isSnowflake("123456789012345678")).toBe(true);
    expect(isSnowflake(" 12345678901234567 ")).toBe(true);
    expect(isSnowflake("1234")).toBe(false);
    expect(isSnowflake("abc123456789012345")).toBe(false);
  });
});
