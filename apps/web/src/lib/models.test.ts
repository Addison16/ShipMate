import { describe, expect, it } from "vitest";
import {
  groupByProvider,
  modelLabel,
  providerLabel,
  providerOf,
  readModel,
  withModel,
} from "./models.js";

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

describe("provider grouping", () => {
  it("groups models by provider in order", () => {
    const g = groupByProvider([
      { ref: "openai/a", name: "A" },
      { ref: "anthropic/b", name: "B" },
      { ref: "openai/c", name: "C", provider: "openai" },
    ]);
    expect([...g.keys()]).toEqual(["openai", "anthropic"]);
    expect(g.get("openai")?.map((m) => m.ref)).toEqual(["openai/a", "openai/c"]);
    expect(providerLabel("claude-code")).toBe("Claude subscription");
    expect(providerLabel("mystery")).toBe("mystery");
    expect(providerOf("default")).toBe("");
  });
});
