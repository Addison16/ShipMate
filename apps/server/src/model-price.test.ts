import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { modelList, modelPrice } from "./model-price.js";

const model = (provider: string, id: string, input: number, output: number) =>
  ({ provider, id, name: id, cost: { input, output } }) as unknown as Model<Api>;

const available = [
  model("anthropic", "big", 15, 75),
  model("anthropic", "small", 0.8, 4),
  model("ollama", "llama", 0, 0),
];

describe("model prices for the Captain", () => {
  it("prices API models per million tokens", () => {
    expect(modelPrice("anthropic/big", available)).toBe("$15 in / $75 out per million tokens");
    expect(modelPrice("anthropic/small", available)).toBe("$0.8 in / $4 out per million tokens");
    expect(modelPrice("ollama/llama", available)).toBe("no per-token price");
    expect(modelPrice("openai/missing", available)).toBe("not set up");
  });

  it("describes Claude subscription models by how fast they use its limits", () => {
    expect(modelPrice("claude-code/haiku", available)).toMatch(/smallest/);
    expect(modelPrice("claude-code/opus", available)).toMatch(/largest/);
  });

  it("lists models cheapest first, with the subscription only when it is in use", () => {
    const list = modelList(available, false).split("\n");
    expect(list.map((l) => l.split(":")[0])).toEqual([
      "- ollama/llama",
      "- anthropic/small",
      "- anthropic/big",
    ]);
    expect(modelList(available, true)).toMatch(/claude-code\/haiku: Claude subscription/);
  });
});
