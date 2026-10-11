import { describe, expect, it } from "vitest";
import { splitMessage } from "./split.js";

describe("splitMessage", () => {
  it("leaves short messages alone", () => {
    expect(splitMessage("Ahoy")).toEqual(["Ahoy"]);
  });

  it("splits on paragraph breaks first, then lines", () => {
    const para = "a".repeat(60);
    const text = [para, para, para].join("\n\n");
    const parts = splitMessage(text, 130);
    expect(parts).toEqual([`${para}\n\n${para}`, para]);
    const lines = ["x".repeat(50), "y".repeat(50), "z".repeat(50)].join("\n");
    expect(splitMessage(lines, 110)).toEqual([
      `${"x".repeat(50)}\n${"y".repeat(50)}`,
      "z".repeat(50),
    ]);
  });

  it("never exceeds the limit and keeps every word", () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
    const parts = splitMessage(words);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
    expect(parts.join(" ")).toBe(words);
  });

  it("hard-cuts text without any break", () => {
    const parts = splitMessage("q".repeat(4500));
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
    expect(parts.join("")).toBe("q".repeat(4500));
  });

  it("closes and reopens a code block cut in two", () => {
    const code = Array.from({ length: 80 }, (_, i) => `  line ${i}`).join("\n");
    const parts = splitMessage(`Here:\n\`\`\`\n${code}\n\`\`\``, 400);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(400);
      expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(parts[1]?.startsWith("```\n  line")).toBe(true);
  });
});
