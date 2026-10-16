import { describe, expect, it } from "vitest";
import {
  contextFullError,
  friendlyModelError,
  ModelError,
  serviceName,
  toModelError,
} from "./model-errors.js";

const CLOUDFLARE_520 =
  'OpenAI API error (520): 520 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-520/","title":"Error 520: Web server is returning an unknown error","status":520,"retryable":true,"retry_after":60}';

describe("friendlyModelError", () => {
  it("turns a Cloudflare 520 from OpenAI into a short message and keeps the raw text", () => {
    const err = friendlyModelError(CLOUDFLARE_520, "OpenAI");
    expect(err).toBeInstanceOf(ModelError);
    expect(err?.message).toMatch(/^OpenAI is having trouble right now/);
    expect(err?.message).not.toContain("{");
    expect(err?.detail).toBe(CLOUDFLARE_520);
  });

  it("names the API from the error when the provider has no name of its own", () => {
    expect(friendlyModelError(CLOUDFLARE_520, serviceName("my-proxy"))?.message).toMatch(
      /^OpenAI is having trouble/,
    );
  });

  it("words rate limits as busy", () => {
    expect(friendlyModelError("429 Too Many Requests", "Anthropic")?.message).toMatch(
      /^Anthropic is busy right now/,
    );
  });

  it("covers dropped connections and overloads", () => {
    expect(friendlyModelError("fetch failed", "ChatGPT")).toBeInstanceOf(ModelError);
    expect(friendlyModelError("API Error: 529 overloaded_error", "Claude")).toBeInstanceOf(
      ModelError,
    );
  });

  it("leaves errors a person must fix unchanged", () => {
    expect(friendlyModelError("401 Incorrect API key provided", "OpenAI")).toBeUndefined();
    expect(
      friendlyModelError("429 insufficient_quota: check your billing", "OpenAI"),
    ).toBeUndefined();
    expect(friendlyModelError("model gpt-9 is not configured", "OpenAI")).toBeUndefined();
  });
});

describe("toModelError", () => {
  it("wraps temporary failures and passes others through", () => {
    const plain = new Error("Codex CLI is not signed in");
    expect(toModelError(plain, "OpenAI")).toBe(plain);
    const wrapped = toModelError(new Error("503 Service Unavailable"), "OpenAI");
    expect(wrapped).toBeInstanceOf(ModelError);
    expect(toModelError(wrapped, "OpenAI")).toBe(wrapped);
  });
});

describe("serviceName", () => {
  it("names known providers and falls back for the rest", () => {
    expect(serviceName("openai-codex")).toBe("ChatGPT");
    expect(serviceName("openai")).toBe("OpenAI");
    expect(serviceName("lm-studio")).toBe("The AI service");
  });
});

describe("contextFullError", () => {
  const reply = (over: Record<string, unknown>) =>
    ({
      role: "assistant",
      content: [],
      stopReason: "stop",
      usage: { input: 32000, output: 1 },
      ...over,
    }) as unknown as Parameters<typeof contextFullError>[0];
  const strata = { name: "Strata", contextWindow: 32768 };

  it("explains a blank reply cut off by a full context", () => {
    const err = contextFullError(reply({ stopReason: "length" }), strata);
    expect(err).toBeInstanceOf(ModelError);
    expect(err?.message).toBe(
      "This chat is too long for Strata (it holds about 32K tokens). Tap Start fresh to keep going. If the model can hold more, raise its context size on the Providers page.",
    );
  });

  it("explains a server's own context-overflow error", () => {
    const err = contextFullError(
      reply({
        stopReason: "error",
        errorMessage: "400 This model's maximum context length is 32768 tokens",
      }),
      strata,
    );
    expect(err?.detail).toMatch(/maximum context length/);
  });

  it("leaves real replies and other errors alone", () => {
    const text = [{ type: "text", text: "Here is the rest" }];
    expect(
      contextFullError(reply({ stopReason: "length", content: text }), strata),
    ).toBeUndefined();
    expect(contextFullError(reply({}), strata)).toBeUndefined();
    // A short chat whose whole reply allowance went on thinking is not a full context.
    const thinking = reply({ stopReason: "length", usage: { input: 2000, output: 8192 } });
    expect(contextFullError(thinking, strata)).toBeUndefined();
    expect(
      contextFullError(reply({ stopReason: "error", errorMessage: "fetch failed" }), strata),
    ).toBeUndefined();
  });
});
