import { describe, expect, it } from "vitest";
import { chatTitle } from "./title.js";

describe("chatTitle", () => {
  it("drops the greeting and the asking words", () => {
    expect(chatTitle("Hey there, can you please plan dinners for next week?")).toBe(
      "Plan dinners for next week?",
    );
    expect(chatTitle("hello! I need you to fix the login bug")).toBe("Fix the login bug");
  });

  it("stops at the first sentence", () => {
    expect(chatTitle("Summarise this article for me. It is long and I only need the gist.")).toBe(
      "Summarise this article for me",
    );
  });

  it("cuts long names at a word and marks the cut", () => {
    const t = chatTitle(
      "compare the three internet plans we were sent last month and tell me which is cheapest over two years",
    );
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith("…")).toBe(true);
    expect(t).toBe("Compare the three internet plans we were sent last month…");
  });

  it("ignores code blocks, links and markdown marks", () => {
    expect(chatTitle("Why does **this** fail?\n```js\nconst a = 1\n```")).toBe(
      "Why does this fail?",
    );
    expect(chatTitle("read https://example.com/a/very/long/path and summarise")).toBe(
      "Read and summarise",
    );
  });

  it("keeps a message that is only a greeting, and falls back to file names", () => {
    expect(chatTitle("hello")).toBe("Hello");
    expect(chatTitle("", ["receipt.jpg", "bill.pdf"])).toBe("Receipt.jpg, bill.pdf");
  });
});
