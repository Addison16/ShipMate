import { describe, expect, it } from "vitest";
import { checkCrewFile, redactedNotice } from "./crew-bundle.js";

describe("crew files", () => {
  it("checks a file before reading it", () => {
    expect(checkCrewFile({ name: "galley.shipmate-crew.json", size: 2000 })).toBeNull();
    expect(checkCrewFile({ name: "galley.json", size: 0 })).toMatch(/empty/);
    expect(checkCrewFile({ name: "galley.json", size: 600 * 1024 })).toMatch(/too large/);
    expect(checkCrewFile({ name: "galley.exe", size: 10 })).toMatch(/\.shipmate-crew\.json/);
  });

  it("explains redactions", () => {
    expect(redactedNotice(null)).toBeNull();
    expect(redactedNotice("0")).toBeNull();
    expect(redactedNotice("1")).toMatch(/^1 value that looked like a key or token was replaced/);
    expect(redactedNotice("3")).toMatch(/^3 values .* were replaced/);
  });
});
