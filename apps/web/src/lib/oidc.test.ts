import { describe, expect, it } from "vitest";
import { loginErrorCode, oidcErrorMessage, oidcStartUrl, parseDomains } from "./oidc.js";

describe("oidc helpers", () => {
  it("reads the login error code from the hash", () => {
    expect(loginErrorCode("#/login?error=no_account")).toBe("no_account");
    expect(loginErrorCode("#/login")).toBeNull();
    expect(loginErrorCode("")).toBeNull();
  });

  it("explains known and unknown codes", () => {
    expect(oidcErrorMessage("domain")).toMatch(/domain/);
    expect(oidcErrorMessage("weird")).toMatch(/did not work/);
    expect(oidcErrorMessage(null)).toBeNull();
  });

  it("only passes hash routes as next", () => {
    expect(oidcStartUrl("#/crew")).toBe("/api/auth/oidc/start?next=%23%2Fcrew");
    expect(oidcStartUrl("#/login?error=x")).toContain("next=");
    expect(oidcStartUrl("")).toBe("/api/auth/oidc/start");
    expect(oidcStartUrl("https://evil.example")).toBe("/api/auth/oidc/start");
  });

  it("parses a domain list", () => {
    expect(parseDomains(" Example.org, @example.org\nfoo.test ")).toEqual([
      "example.org",
      "foo.test",
    ]);
    expect(parseDomains("")).toEqual([]);
  });
});
