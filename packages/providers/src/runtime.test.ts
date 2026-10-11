import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ProviderBinder, piProviderId, probeModels } from "./runtime.js";

async function runtime() {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  return ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
}

describe("ProviderBinder", () => {
  it("registers self-hosted models and removes them again", async () => {
    const rt = await runtime();
    const binder = new ProviderBinder(rt);
    const ollama = {
      id: "1",
      kind: "ollama",
      label: "Ollama",
      baseUrl: "http://ollama:11434/v1",
      apiKey: null,
      models: ["qwen3:32b"],
      enabled: true,
    };
    await binder.sync([ollama]);
    expect(rt.getModel("ollama", "qwen3:32b")?.baseUrl).toBe("http://ollama:11434/v1");
    await binder.sync([{ ...ollama, enabled: false }]);
    expect(rt.getModel("ollama", "qwen3:32b")).toBeUndefined();
  });

  it("sets runtime keys for API-key kinds", async () => {
    const rt = await runtime();
    const binder = new ProviderBinder(rt);
    const record = {
      id: "2",
      kind: "anthropic",
      label: "Anthropic",
      baseUrl: null,
      apiKey: "sk-test",
      models: [],
      enabled: true,
    };
    await binder.sync([record]);
    expect(rt.hasConfiguredAuth("anthropic")).toBe(true);
    await binder.sync([]);
    expect(rt.getProviderAuthStatus("anthropic").source).not.toBe("runtime");
  });

  it("names OpenAI-compatible providers after their label", () => {
    expect(piProviderId({ kind: "openai-compatible", label: "LM Studio" })).toBe("lm-studio");
    expect(piProviderId({ kind: "openai", label: "whatever" })).toBe("openai");
  });
});

describe("probeModels", () => {
  it("reads OpenAI-style and Ollama-style lists", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ data: [{ id: "b" }, { id: "a" }], models: [{ name: "a" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await probeModels("http://x/v1/", null, fake)).toEqual(["a", "b"]);
  });
});
