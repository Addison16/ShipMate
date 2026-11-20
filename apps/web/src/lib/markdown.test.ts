import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref, splitRow } from "./markdown.js";

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

describe("tables, rules, checklists and strikethrough", () => {
  const text = (s: string) => [{ t: "text", text: s }];

  it("parses a table with alignment and short rows", () => {
    const src = "| Item | Price |\n| :--- | ---: |\n| Milk | 3 |\n| Bread |\nafter";
    expect(parseMarkdown(src)).toEqual([
      {
        t: "table",
        align: ["left", "right"],
        head: [text("Item"), text("Price")],
        rows: [
          [text("Milk"), text("3")],
          [text("Bread"), []],
        ],
      },
      { t: "p", children: text("after") },
    ]);
  });

  it("parses a table without the outer bars", () => {
    const [b] = parseMarkdown("a | b\n--|--\n1 | 2");
    expect(b).toMatchObject({
      t: "table",
      head: [text("a"), text("b")],
      rows: [[text("1"), text("2")]],
    });
  });

  it("shows a table header alone while the rows are still streaming", () => {
    expect(parseMarkdown("| a | b |\n|---|---|")).toEqual([
      { t: "table", align: [null, null], head: [text("a"), text("b")], rows: [] },
    ]);
  });

  it("does not take a sentence with a bar, or a mismatched rule, for a table", () => {
    expect(parseMarkdown("a | b\nplain")[0]?.t).toBe("p");
    expect(parseMarkdown("a | b | c\n---|---")[0]?.t).toBe("p");
    expect(parseMarkdown("Heading\n---")[0]?.t).toBe("p");
  });

  it("keeps bars inside code and escaped bars in one cell", () => {
    expect(splitRow("| `a|b` | c \\| d |")).toEqual(["`a|b`", "c | d"]);
  });

  it("parses rules, but not list items, as rules", () => {
    expect(parseMarkdown("---\n***\n- - -").map((b) => b.t)).toEqual(["hr", "hr", "hr"]);
    expect(parseMarkdown("- one")[0]?.t).toBe("list");
  });

  it("parses checklists", () => {
    expect(parseMarkdown("- [x] done\n- [ ] todo\n- plain")).toEqual([
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [text("done"), text("todo"), text("plain")],
        checks: [true, false, null],
      },
    ]);
  });

  it("parses strikethrough", () => {
    expect(parseInline("was ~~10~~ 8")).toEqual([
      { t: "text", text: "was " },
      { t: "del", children: text("10") },
      { t: "text", text: " 8" },
    ]);
    expect(parseInline("a ~~ b")).toEqual(text("a ~~ b"));
  });
});
