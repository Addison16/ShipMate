import { describe, expect, it } from "vitest";
import { inQuietHours } from "./phone.js";

const at = (iso: string) => new Date(iso);

describe("inQuietHours", () => {
  const night = { from: "22:00", to: "07:00", timezone: "UTC" };

  it("covers a span that crosses midnight", () => {
    expect(inQuietHours(night, at("2026-11-20T23:30:00Z"))).toBe(true);
    expect(inQuietHours(night, at("2026-11-20T06:59:00Z"))).toBe(true);
    expect(inQuietHours(night, at("2026-11-20T07:00:00Z"))).toBe(false);
    expect(inQuietHours(night, at("2026-11-20T21:59:00Z"))).toBe(false);
    expect(inQuietHours(night, at("2026-11-20T22:00:00Z"))).toBe(true);
  });

  it("covers a span inside one day", () => {
    const nap = { from: "13:00", to: "15:00", timezone: "UTC" };
    expect(inQuietHours(nap, at("2026-11-20T14:00:00Z"))).toBe(true);
    expect(inQuietHours(nap, at("2026-11-20T15:00:00Z"))).toBe(false);
  });

  it("uses the device's timezone", () => {
    const chicago = { ...night, timezone: "America/Chicago" };
    // 05:00 UTC is 23:00 the evening before in Chicago (winter).
    expect(inQuietHours(chicago, at("2026-11-20T05:00:00Z"))).toBe(true);
    expect(inQuietHours(chicago, at("2026-11-20T18:00:00Z"))).toBe(false);
  });

  it("is off for no setting, equal times, bad times or an unknown timezone", () => {
    const now = at("2026-11-20T23:30:00Z");
    expect(inQuietHours(null, now)).toBe(false);
    expect(inQuietHours({ from: "22:00", to: "22:00", timezone: "UTC" }, now)).toBe(false);
    expect(inQuietHours({ from: "late", to: "07:00", timezone: "UTC" }, now)).toBe(false);
    expect(inQuietHours({ ...night, timezone: "Mars/Olympus" }, now)).toBe(false);
  });
});
