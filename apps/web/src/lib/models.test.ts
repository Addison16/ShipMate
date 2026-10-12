import { describe, expect, it } from "vitest";
import { modelLabel, readModel, withModel } from "./models.js";

describe("crew model helpers", () => {
  it("reads and sets the model line without touching others", () => {
    const yaml = "name: A\nmodel: openai/gpt-x # mine\ntools: []\n";
    expect(readModel(yaml)).toBe("openai/gpt-x");
    expect(withModel(yaml, "default")).toBe("name: A\nmodel: default\ntools: []\n");
    expect(withModel("name: A\n", "default")).toBe("name: A\nmodel: default\n");
  });

  it("shows what the crew default currently means", () => {
    expect(modelLabel("default", "anthropic/x")).toBe("Crew default (anthropic/x)");
    expect(modelLabel("default")).toBe("Crew default");
    expect(modelLabel("openai/y", "anthropic/x")).toBe("openai/y");
  });
});
