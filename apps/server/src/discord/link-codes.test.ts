import { describe, expect, it } from "vitest";
import { LINK_CODE_TTL_MS, LinkCodes } from "./link-codes.js";

describe("LinkCodes", () => {
  it("issues six-digit codes that work once", () => {
    const codes = new LinkCodes();
    const { code } = codes.issue("u1");
    expect(code).toMatch(/^\d{6}$/);
    expect(codes.consume(code)).toBe("u1");
    expect(codes.consume(code)).toBeNull();
    expect(codes.consume("000000x")).toBeNull();
  });

  it("expires after ten minutes", () => {
    let now = 1_000_000;
    const codes = new LinkCodes(LINK_CODE_TTL_MS, () => now);
    const a = codes.issue("u1");
    expect(a.expiresAt.getTime()).toBe(now + 10 * 60_000);
    now += LINK_CODE_TTL_MS - 1;
    const b = codes.issue("u2");
    now += 1;
    expect(codes.consume(a.code)).toBeNull();
    expect(codes.consume(b.code)).toBe("u2");
  });

  it("replaces a person's previous code", () => {
    const codes = new LinkCodes();
    const first = codes.issue("u1");
    const second = codes.issue("u1");
    expect(codes.consume(first.code)).toBeNull();
    expect(codes.consume(second.code)).toBe("u1");
  });
});
