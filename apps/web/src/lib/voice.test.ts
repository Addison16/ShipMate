import { describe, expect, it } from "vitest";
import { recorderType, speakableText, speechChunks } from "./voice.js";

describe("voice helpers", () => {
  it("turns Markdown replies into something worth hearing", () => {
    expect(
      speakableText("## Plan\n\n**Monday**: soup. See [the recipe](https://x.example/r)."),
    ).toBe("Plan. Monday: soup. See the recipe.");
    expect(speakableText("Run this:\n\n```bash\nrm -rf /\n```\n\nThen `ls`.")).toBe(
      "Run this: (code omitted). Then ls.",
    );
    expect(speakableText("- eggs\n- milk")).toBe("eggs milk");
    expect(speakableText("Open my_notes_file now, *please*.")).toBe(
      "Open my_notes_file now, please.",
    );
    expect(speakableText("Read https://www.example.com/very/long?x=1 later")).toBe(
      "Read a link to example.com later",
    );
    expect(speakableText("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a, b 1, 2");
  });

  it("splits long text into sentence-sized pieces", () => {
    expect(speechChunks("One. Two! Three?", 10)).toEqual(["One. Two!", "Three?"]);
    expect(speechChunks("Short.", 220)).toEqual(["Short."]);
    const long = `${"word ".repeat(100)}end.`;
    const parts = speechChunks(long, 50);
    expect(parts.every((p) => p.length <= 50)).toBe(true);
    expect(parts.join(" ")).toBe(long.trim());
    expect(speechChunks("", 10)).toEqual([]);
  });

  it("picks a recording format the browser supports", () => {
    expect(recorderType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(recorderType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(recorderType(() => false)).toBeUndefined();
  });
});
