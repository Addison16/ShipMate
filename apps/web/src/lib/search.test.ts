import { describe, expect, it } from "vitest";
import { MARK_END, MARK_START, splitHighlights } from "./search.js";

const m = (s: string) => `${MARK_START}${s}${MARK_END}`;

describe("splitHighlights", () => {
  it("splits marked words from plain text", () => {
    expect(splitHighlights(`a ${m("lasagna")} with ${m("basil")}`)).toEqual([
      { text: "a ", mark: false },
      { text: "lasagna", mark: true },
      { text: " with ", mark: false },
      { text: "basil", mark: true },
    ]);
  });

  it("merges adjacent marks and tolerates a missing end", () => {
    expect(splitHighlights(`${m("veg")}${m("gie")} x`)).toEqual([
      { text: "veggie", mark: true },
      { text: " x", mark: false },
    ]);
    expect(splitHighlights(`x ${MARK_START}open`)).toEqual([
      { text: "x ", mark: false },
      { text: "open", mark: true },
    ]);
    expect(splitHighlights("")).toEqual([]);
    expect(splitHighlights("<b>no html</b>")).toEqual([{ text: "<b>no html</b>", mark: false }]);
  });
});
