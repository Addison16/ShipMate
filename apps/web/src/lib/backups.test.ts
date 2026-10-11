import { describe, expect, it } from "vitest";
import { backupDownloadUrl, describeHour, formatBytes } from "./backups.js";

describe("backups helpers", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
  it("encodes download names", () => {
    expect(backupDownloadUrl("a b.tar.gz")).toBe("/api/backups/a%20b.tar.gz");
  });
  it("describes the hour in UTC", () => {
    expect(describeHour(3)).toMatch(/^03:00 UTC/);
  });
});
