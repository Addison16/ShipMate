import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "./markdown.js";

describe("parseMarkdown", () => {
  it("keeps raw HTML as plain text nodes", () => {
    const blocks = parseMarkdown('<script>alert("x")</script> <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([
      {
        t: "p",
        children: [{ t: "text", text: '<script>alert("x")</script> <img src=x onerror=alert(1)>' }],
      },
    ]);
  });

  it("parses fenced code verbatim, including markdown inside it", () => {
    const blocks = parseMarkdown("before\n```ts\nconst a = **b**;\n<div>\n```\nafter");
    expect(blocks).toEqual([
      { t: "p", children: [{ t: "text", text: "before" }] },
      { t: "code", lang: "ts", text: "const a = **b**;\n<div>" },
      { t: "p", children: [{ t: "text", text: "after" }] },
    ]);
  });

  it("treats an unclosed fence (mid-stream) as code to the end", () => {
    expect(parseMarkdown("```\nline 1\nline 2")).toEqual([
      { t: "code", lang: "", text: "line 1\nline 2" },
    ]);
  });

  it("parses lists and headings", () => {
    const blocks = parseMarkdown("## Plan\n- one\n- **two**\n\n3. c\n4. d");
    expect(blocks).toEqual([
      { t: "heading", level: 2, children: [{ t: "text", text: "Plan" }] },
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [
          [{ t: "text", text: "one" }],
          [{ t: "strong", children: [{ t: "text", text: "two" }] }],
        ],
      },
      {
        t: "list",
        ordered: true,
        start: 3,
        items: [[{ t: "text", text: "c" }], [{ t: "text", text: "d" }]],
      },
    ]);
  });

  it("joins paragraph lines with line breaks", () => {
    expect(parseMarkdown("a\nb")).toEqual([
      { t: "p", children: [{ t: "text", text: "a" }, { t: "br" }, { t: "text", text: "b" }] },
    ]);
  });
});

describe("parseInline", () => {
  it("parses inline code, bold, italics and links", () => {
    expect(parseInline("run `ls -la` **now** *ok* [docs](https://x.dev/a)")).toEqual([
      { t: "text", text: "run " },
      { t: "code", text: "ls -la" },
      { t: "text", text: " " },
      { t: "strong", children: [{ t: "text", text: "now" }] },
      { t: "text", text: " " },
      { t: "em", children: [{ t: "text", text: "ok" }] },
      { t: "text", text: " " },
      { t: "link", href: "https://x.dev/a", children: [{ t: "text", text: "docs" }] },
    ]);
  });

  it("refuses unsafe link schemes", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { t: "text", text: "[click](javascript:alert(1))" },
    ]);
  });

  it("autolinks bare urls without trailing punctuation", () => {
    expect(parseInline("see https://example.com/x.")).toEqual([
      { t: "text", text: "see " },
      {
        t: "link",
        href: "https://example.com/x",
        children: [{ t: "text", text: "https://example.com/x" }],
      },
      { t: "text", text: "." },
    ]);
  });

  it("does not parse markdown inside code spans", () => {
    expect(parseInline("`**x**`")).toEqual([{ t: "code", text: "**x**" }]);
  });
});

describe("safeHref", () => {
  it("allows http, https and mailto only", () => {
    expect(safeHref("https://a.b")).toBe("https://a.b");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("//evil.com")).toBeNull();
  });
});
