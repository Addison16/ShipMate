import { describe, expect, it } from "vitest";
import { canHighlight, highlight } from "./highlight.js";

const kinds = (text: string, lang: string) =>
  highlight(text, lang)
    .filter((t) => t.kind)
    .map((t) => [t.kind, t.text]);

describe("highlight", () => {
  it("never loses or changes a character", () => {
    const src = 'const a = "x // y"; /* note */ let n = 0x1f + 2.5e3; // end\n`multi\nline`';
    expect(
      highlight(src, "ts")
        .map((t) => t.text)
        .join(""),
    ).toBe(src);
  });

  it("labels keywords, strings, numbers and comments", () => {
    expect(kinds('const a = "hi"; // why\nreturn 42', "js")).toEqual([
      ["keyword", "const"],
      ["string", '"hi"'],
      ["comment", "// why"],
      ["keyword", "return"],
      ["number", "42"],
    ]);
  });

  it("does not treat comment marks inside a string as a comment", () => {
    expect(kinds('x = "# not a comment"  # real', "python")).toEqual([
      ["string", '"# not a comment"'],
      ["comment", "# real"],
    ]);
  });

  it("keeps $# and URLs out of shell comments", () => {
    expect(kinds("echo $# http://a/#b", "bash")).toEqual([["keyword", "echo"]]);
  });

  it("matches SQL keywords in any case", () => {
    expect(kinds("SELECT name From t -- all", "sql")).toEqual([
      ["keyword", "SELECT"],
      ["keyword", "From"],
      ["comment", "-- all"],
    ]);
  });

  it("stops an unclosed quote at the end of its line", () => {
    expect(kinds("a = 'oops\nb = 1", "py")).toEqual([
      ["string", "'oops"],
      ["number", "1"],
    ]);
  });

  it("leaves unknown languages and huge blocks plain", () => {
    expect(highlight("if x then y", "brainfuzz")).toEqual([{ text: "if x then y", kind: null }]);
    expect(canHighlight("constructor")).toBe(false);
    const big = "x ".repeat(15_000);
    expect(highlight(big, "js")).toEqual([{ text: big, kind: null }]);
  });
});
