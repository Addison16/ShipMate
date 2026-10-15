import {
  type AssistantMessage,
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";

/**
 * A model call that failed for a reason on the provider's side (an outage, a rate limit, a
 * dropped connection). `message` is short and plain for the chat; `detail` is the provider's
 * own text, shown behind "More details".
 */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

const SERVICE_NAMES: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "ChatGPT",
  anthropic: "Anthropic",
  xai: "xAI",
  google: "Google",
  openrouter: "OpenRouter",
  ollama: "Ollama",
};

/** A person-facing name for a pi provider id, e.g. `openai-codex` → ChatGPT. */
export function serviceName(provider: string | undefined): string {
  return (provider && SERVICE_NAMES[provider]) || "The AI service";
}

/** pi names the API in its errors ("OpenAI API error (520): …"); prefer that when it does. */
function namedIn(raw: string): string | undefined {
  return /^(OpenAI|Anthropic|Mistral|Google|Gemini|xAI|OpenRouter) API error/i.exec(raw)?.[1];
}

const RATE_LIMIT = /\b429\b|rate.?limit|too many requests/i;

/**
 * Turn a temporary provider failure into a short message, keeping the raw text as detail.
 * Uses pi's own test for what is worth retrying, so this matches what was already retried.
 * Anything else (a bad key, a used-up plan, a missing model) comes back unchanged: the raw
 * text says what to fix.
 */
export function friendlyModelError(raw: string, service: string): ModelError | undefined {
  if (!isRetryableAssistantError({ stopReason: "error", errorMessage: raw } as never)) {
    return undefined;
  }
  if (service === serviceName(undefined)) service = namedIn(raw) ?? service;
  const message = RATE_LIMIT.test(raw)
    ? `${service} is busy right now and asked Shipmate to slow down. It tried again a few times. Try again in a minute.`
    : `${service} is having trouble right now, so the reply didn't come through. Shipmate tried again a few times. Try again in a minute.`;
  return new ModelError(message, raw);
}

/** `err` as a ModelError when it is a temporary provider failure; otherwise unchanged. */
export function toModelError(err: unknown, service: string): unknown {
  if (!(err instanceof Error) || err instanceof ModelError) return err;
  const friendly = friendlyModelError(err.message, service);
  return friendly ? Object.assign(friendly, { stack: err.stack }) : err;
}

/** `32768` → `32K`, `524288` → `512K`. */
function tokenSize(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

/**
 * The chat no longer fits the model, and pi's own summarising did not make room. A local server
 * either says so (an error) or, more often, is asked for a reply only a token or two long and
 * stops with nothing to show. Both end the turn with a plain next step instead of a blank reply.
 */
export function contextFullError(
  message: AssistantMessage,
  model: { name: string; contextWindow: number } | undefined,
): ModelError | undefined {
  const nothingSaid = !message.content.some(
    (c) => (c.type === "text" && c.text.trim()) || c.type === "toolCall",
  );
  const full =
    (message.stopReason === "length" && nothingSaid) ||
    (message.stopReason === "error" && isContextOverflow(message, model?.contextWindow));
  if (!full) return undefined;
  const size = model?.contextWindow
    ? ` (it holds about ${tokenSize(model.contextWindow)} tokens)`
    : "";
  const name = model?.name ?? "this model";
  return new ModelError(
    `This chat is too long for ${name}${size}. Tap Start fresh to keep going. If the model can hold more, raise its context size on the Providers page.`,
    message.errorMessage ||
      `The model stopped after ${message.usage?.output ?? 0} tokens because the chat filled its context window.`,
  );
}
