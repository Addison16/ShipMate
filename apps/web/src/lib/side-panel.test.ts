import { describe, expect, it } from "vitest";
import { panelFileName, panelFrameDocument, panelItem, panelKind } from "./side-panel.js";

describe("side panel items", () => {
  it("tells pages, pictures, documents and code apart", () => {
    expect(panelKind("html", "<p>hi</p>")).toBe("page");
    expect(panelKind("", "<!DOCTYPE html><html></html>")).toBe("page");
    expect(panelKind("svg", "<svg></svg>")).toBe("picture");
    expect(panelKind("xml", '  <svg viewBox="0 0 1 1"></svg>')).toBe("picture");
    expect(panelKind("xml", "<note/>")).toBe("code");
    expect(panelKind("Markdown", "# Plan")).toBe("document");
    expect(panelKind("python", "print(1)")).toBe("code");
  });

  it("opens long code but leaves a few lines in the chat", () => {
    expect(panelItem("python", "print(1)\nprint(2)")).toBeNull();
    const long = Array.from({ length: 20 }, (_, i) => `print(${i})`).join("\n");
    expect(panelItem("python", long)).toMatchObject({ kind: "code", title: "python code" });
    expect(panelItem("html", "<p>short</p>")).toMatchObject({ kind: "page", title: "Page" });
  });

  it("names things from their own title", () => {
    const page = panelItem("html", "<html><head><title> Trip  budget </title></head></html>");
    expect(page?.title).toBe("Trip budget");
    expect(page && panelFileName(page)).toBe("trip-budget.html");
    const doc = panelItem("md", "intro\n\n## Packing list\n- socks");
    expect(doc?.title).toBe("Packing list");
    expect(doc && panelFileName(doc)).toBe("packing-list.md");
    const code = panelItem("ts", "x\n".repeat(30));
    expect(code && panelFileName(code)).toBe("ts-code.ts");
  });

  it("puts the page rules before anything the page wrote", () => {
    const rules = '<meta http-equiv="Content-Security-Policy"';
    const page = (text: string) =>
      panelFrameDocument({ kind: "page", title: "", lang: "html", text });
    const full = page('<!DOCTYPE html>\n<html lang="en"><head><script>a()</script></head></html>');
    expect(full.startsWith(`<!DOCTYPE html>${rules}`)).toBe(true);
    // A script placed ahead of a <head> must not get in before the rules.
    const early = page("<script>a()</script><head></head><p>hi</p>");
    expect(early.startsWith(`<!doctype html>${rules}`)).toBe(true);
    expect(early).toContain("default-src 'none'");
    expect(early).not.toContain("connect-src");
    const picture = panelFrameDocument({
      kind: "picture",
      title: "",
      lang: "svg",
      text: "<svg><script>a()</script></svg>",
    });
    expect(picture.indexOf(rules)).toBeLessThan(picture.indexOf("<svg>"));
  });
});
