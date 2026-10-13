import { describe, expect, it } from "vitest";
import { googleResult, isLoopbackHost } from "./google-mcp.js";

describe("google-mcp", () => {
  it("reads the sign-in result from the hash", () => {
    expect(googleResult("#/mcp")).toBeNull();
    expect(googleResult("#/mcp?google=ok")).toEqual({ ok: true, text: "Signed in to Google." });
    expect(googleResult("#/mcp?google=denied")?.ok).toBe(false);
    expect(googleResult("#/mcp?google=weird")?.text).toMatch(/could not finish/);
  });

  it("spots the Shipmate machine itself", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("192.168.1.4")).toBe(false);
  });
});
