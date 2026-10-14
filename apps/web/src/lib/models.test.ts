import { describe, expect, it } from "vitest";
import {
  defaultModelStatus,
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

  it("says when the crew default is not something you are signed in to", () => {
    const models = [
      { ref: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", available: false },
      { ref: "openai-codex/gpt-5", name: "GPT-5 (ChatGPT)", available: true },
    ];
    expect(defaultModelStatus("anthropic/claude-sonnet-5-5", models, false)).toEqual({
      usable: false,
      fallback: "GPT-5 (ChatGPT)",
    });
    expect(defaultModelStatus("openai-codex/gpt-5", models, false).usable).toBe(true);
    expect(defaultModelStatus("claude-code/sonnet", models, true).usable).toBe(true);
    expect(defaultModelStatus("codex/gpt-6.1-sol", models, false, true).usable).toBe(true);
    expect(defaultModelStatus("codex/gpt-6.1-sol", models, false, false).usable).toBe(false);
    // A model its provider dropped falls back to that provider's first (newest) one.
    const plan = [
      { ref: "ollama/llama", name: "Llama", available: true },
      { ref: "chatgpt/gpt-6.1-sol", name: "GPT-6.1 Sol", available: true },
    ];
    expect(defaultModelStatus("chatgpt/gpt-4", plan, false)).toEqual({
      usable: false,
      fallback: "GPT-6.1 Sol",
    });
    expect(defaultModelStatus("claude-code/sonnet", [], false)).toEqual({
      usable: false,
      fallback: null,
    });
  });
});
