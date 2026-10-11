import { describe, expect, it } from "vitest";
import { CrewManifest, CrewSlug } from "./crew.js";

describe("CrewManifest", () => {
  it("applies defaults", () => {
    const m = CrewManifest.parse({
      name: "Captain",
      role: "coordinator",
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(m.approval).toBe("ask");
    expect(m.visibility).toBe("shared");
    expect(m.tools).toEqual([]);
  });
  it("rejects a bad model ref", () => {
    expect(() => CrewManifest.parse({ name: "x", role: "y", model: "gpt-5" })).toThrow();
  });
  it("validates slugs", () => {
    expect(CrewSlug.safeParse("galley").success).toBe(true);
    expect(CrewSlug.safeParse("Galley!").success).toBe(false);
  });
});
