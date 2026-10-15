import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ProviderBinder, piProviderId, probeModels, probeServer } from "./runtime.js";

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

  it("tells pi each local model's context size: the owner's, the server's, or 32K", async () => {
    const rt = await runtime();
    const binder = new ProviderBinder(rt);
    const local = {
      id: "1",
      kind: "openai-compatible",
      label: "Local",
      baseUrl: "http://lm:1234/v1",
      apiKey: null,
      models: ["strata", "small"],
      enabled: true,
      modelContexts: { strata: 524288 },
    };
    await binder.sync([local]);
    expect(rt.getModel("local", "strata")?.contextWindow).toBe(524288);
    expect(rt.getModel("local", "strata")?.maxTokens).toBe(8192);
    expect(rt.getModel("local", "small")?.contextWindow).toBe(32768);
    await binder.sync([{ ...local, contextWindow: 8192 }]);
    expect(rt.getModel("local", "strata")?.contextWindow).toBe(8192);
    expect(rt.getModel("local", "strata")?.maxTokens).toBe(2048);
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

describe("probeServer", () => {
  const server =
    (routes: Record<string, unknown>) =>
    async (url: string | URL | Request): Promise<Response> => {
      const body = routes[String(url)];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    };

  it("reads context sizes from the model list", async () => {
    const fake = server({
      "http://x/v1/models": {
        data: [
          { id: "llama", meta: { n_ctx: 65536, n_ctx_train: 131072 } },
          { id: "vllm", max_model_len: 524288 },
          { id: "lms", loaded_context_length: 32768, max_context_length: 262144 },
        ],
      },
    }) as unknown as typeof fetch;
    expect(await probeServer("http://x/v1", null, fake)).toEqual({
      models: ["llama", "lms", "vllm"],
      contexts: { llama: 65536, vllm: 524288, lms: 32768 },
    });
  });

  it("asks the server's own endpoints when the list says nothing", async () => {
    const fake = server({
      "http://x/v1/models": { data: [{ id: "strata" }, { id: "qwen3:4b" }, { id: "other" }] },
      "http://x/api/v0/models": { data: [{ id: "strata", max_context_length: 524288 }] },
      "http://x/api/ps": { models: [{ name: "qwen3:4b", context_length: 8192 }] },
    }) as unknown as typeof fetch;
    expect((await probeServer("http://x/v1", null, fake)).contexts).toEqual({
      strata: 524288,
      "qwen3:4b": 8192,
    });
  });

  it("uses llama.cpp's server-wide size for models it does not list one for", async () => {
    const fake = server({
      "http://x/v1/models": { data: [{ id: "m" }] },
      "http://x/props": { default_generation_settings: { n_ctx: 16384 } },
    }) as unknown as typeof fetch;
    expect((await probeServer("http://x/v1", null, fake)).contexts).toEqual({ m: 16384 });
  });
});
