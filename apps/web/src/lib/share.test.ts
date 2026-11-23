import { describe, expect, it } from "vitest";
import { sharedToken, shareUrl } from "./share.js";

describe("share links", () => {
  it("builds the address and reads the token back", () => {
    const url = shareUrl("aB3_-x", "https://home.example.com");
    expect(url).toBe("https://home.example.com/#/shared/aB3_-x");
    expect(sharedToken(new URL(url).hash)).toBe("aB3_-x");
  });
  it("is not fooled by other pages", () => {
    expect(sharedToken("#/bridge/abc")).toBeNull();
    expect(sharedToken("#/shared/")).toBeNull();
    expect(sharedToken("#/shared/a/b")).toBeNull();
    expect(sharedToken("")).toBeNull();
  });
});
