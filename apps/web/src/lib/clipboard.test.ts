import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.js";

/** Just enough of a document for the textarea fallback. */
function fakeDocument(copyResult: boolean) {
  const area = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const doc = {
    createElement: vi.fn(() => area),
    body: { appendChild: vi.fn() },
    activeElement: { focus: vi.fn() },
    execCommand: vi.fn(() => copyResult),
  };
  return { doc: doc as unknown as Document, area, raw: doc };
}

describe("copyText", () => {
  it("uses the async clipboard when the page has one", async () => {
    const writeText = vi.fn(async () => {});
    const { doc, raw } = fakeDocument(true);
    await copyText("docker exec -it shipmate claude", { clipboard: { writeText }, doc });
    expect(writeText).toHaveBeenCalledWith("docker exec -it shipmate claude");
    expect(raw.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a selected textarea on plain http", async () => {
    const { doc, area, raw } = fakeDocument(true);
    await copyText("/data/claude", { clipboard: undefined, doc });
    expect(area.value).toBe("/data/claude");
    expect(area.select).toHaveBeenCalled();
    expect(raw.execCommand).toHaveBeenCalledWith("copy");
    expect(area.remove).toHaveBeenCalled();
    expect(raw.activeElement.focus).toHaveBeenCalled();
  });

  it("falls back when the async clipboard refuses, and reports a refused copy", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const ok = fakeDocument(true);
    await copyText("x", { clipboard: { writeText }, doc: ok.doc });
    expect(ok.raw.execCommand).toHaveBeenCalled();

    const refused = fakeDocument(false);
    await expect(copyText("x", { clipboard: undefined, doc: refused.doc })).rejects.toThrow();
    expect(refused.area.remove).toHaveBeenCalled();
  });
});
