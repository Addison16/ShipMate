import type { MessageDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { fileProblem, kindOf, messageAttachments } from "./files.js";

const MB = 1024 * 1024;

describe("files in chat", () => {
  it("knows which files it can take", () => {
    expect(kindOf({ name: "a.jpg", type: "image/jpeg" })).toBe("image");
    expect(kindOf({ name: "bill.pdf", type: "" })).toBe("pdf");
    expect(kindOf({ name: "notes.md", type: "" })).toBe("text");
    expect(kindOf({ name: "x.svg", type: "image/svg+xml" })).toBeNull();
    expect(fileProblem({ name: "a.jpg", type: "image/jpeg", size: 2 * MB })).toBeNull();
    expect(fileProblem({ name: "a.jpg", type: "image/jpeg", size: 11 * MB })).toBe(
      "a.jpg is over 10 MB.",
    );
    expect(fileProblem({ name: "IMG_1.HEIC", type: "image/heic", size: MB })).toMatch(/as JPEG/);
    expect(fileProblem({ name: "x.zip", type: "application/zip", size: 1 })).toMatch(
      /photos, PDFs and text files/,
    );
  });

  it("reads attachments from a message defensively", () => {
    const m = (meta: Record<string, unknown> | null): MessageDto => ({
      id: "m",
      conversationId: "c",
      role: "user",
      content: "",
      author: { kind: "user", id: "u", name: "A" },
      meta,
      createdAt: "2026-10-11T00:00:00Z",
    });
    expect(messageAttachments(m(null))).toEqual([]);
    expect(
      messageAttachments(
        m({
          attachments: [
            { id: "1", name: "a.png", kind: "image", mimeType: "image/png", size: 3 },
            { name: "no id" },
            "junk",
          ],
        }),
      ),
    ).toEqual([{ id: "1", name: "a.png", kind: "image", mimeType: "image/png", size: 3 }]);
  });
});
