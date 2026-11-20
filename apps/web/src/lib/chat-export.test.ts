import type { MessageDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { chatFileName, chatMarkdown } from "./chat-export.js";

const msg = (
  id: string,
  author: MessageDto["author"],
  content: string,
  meta: MessageDto["meta"] = null,
): MessageDto => ({
  id,
  conversationId: "c",
  role: author.kind === "user" ? "user" : author.kind === "crew" ? "assistant" : "system",
  content,
  author,
  meta,
  createdAt: "2026-11-20T17:00:00Z",
});

describe("chatMarkdown", () => {
  it("writes who said what, skipping the app's own notes", () => {
    const text = chatMarkdown(
      "Weekly shop",
      [
        msg("1", { kind: "user", id: "me", name: "Sam" }, "Hello", {
          attachments: [{ name: "list.pdf" }],
        }),
        msg("2", { kind: "crew", slug: "captain", name: "Captain" }, "| a | b |\n|---|---|"),
        msg("3", { kind: "system" }, "Captain stopped before finishing", { turnError: true }),
        msg("4", { kind: "system" }, "Fresh start.", { sessionReset: true }),
        msg("5", { kind: "user", id: "other", name: "Kim" }, "And me"),
      ],
      { selfId: "me", crewName: () => "Assistant", locale: "en-US" },
    );
    expect(text.startsWith("# Weekly shop\n\n**You** · ")).toBe(true);
    expect(text).toContain("_Attached: list.pdf_\n\nHello\n");
    expect(text).toContain("**Assistant** · ");
    expect(text).toContain("| a | b |\n|---|---|");
    expect(text).not.toContain("stopped before finishing");
    expect(text).toContain("\n---\n\n**Kim** · ");
    expect(text.endsWith("And me\n")).toBe(true);
  });
});

describe("chatFileName", () => {
  it("makes a name any system will take", () => {
    expect(chatFileName('What is "a/b"?')).toBe("What is a b.md");
    expect(chatFileName("  ...  ")).toBe("chat.md");
  });
});
