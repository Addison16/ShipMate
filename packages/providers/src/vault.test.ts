import { describe, expect, it } from "vitest";
import { SecretVault } from "./vault.js";

describe("SecretVault", () => {
  it("round-trips", () => {
    const v = new SecretVault("a-long-enough-master-secret");
    expect(v.decrypt(v.encrypt("sk-test"))).toBe("sk-test");
  });
  it("rejects tampering", () => {
    const v = new SecretVault("a-long-enough-master-secret");
    const c = Buffer.from(v.encrypt("sk-test"), "base64");
    const last = c.length - 1;
    c[last] = (c[last] ?? 0) ^ 1;
    expect(() => v.decrypt(c.toString("base64"))).toThrow();
  });
});
