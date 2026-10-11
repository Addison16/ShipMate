import { describe, expect, it } from "vitest";
import { AVATAR_TONES, avatarTone, initials } from "./avatar.js";

describe("crew avatars", () => {
  it("gives a name the same color every time, ignoring case", () => {
    expect(avatarTone("Galley")).toBe(avatarTone("galley"));
    expect(AVATAR_TONES).toContain(avatarTone("Purser"));
  });

  it("spreads the starter crew across more than one color", () => {
    const tones = new Set(
      ["Captain", "Galley", "Navigator", "Purser", "Shipwright"].map(avatarTone),
    );
    expect(tones.size).toBeGreaterThan(2);
  });

  it("uses one or two initials", () => {
    expect(initials("Captain")).toBe("C");
    expect(initials("kelp forest bot")).toBe("KF");
    expect(initials("  ")).toBe("");
  });
});
