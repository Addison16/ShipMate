/**
 * Provider kinds Shipmate knows how to configure. pi-ai does the actual calls; this list
 * drives the Providers page and credential validation.
 */
export const PROVIDER_KINDS = [
  { kind: "anthropic", label: "Anthropic (API key)", auth: "api-key" },
  { kind: "openai", label: "OpenAI (API key)", auth: "api-key" },
  {
    kind: "openai-chatgpt",
    label: "ChatGPT plan (Sign in with ChatGPT)",
    auth: "oauth",
  },
  {
    kind: "claude-code-cli",
    label: "Claude subscription (official Claude Code CLI)",
    auth: "external",
  },
  { kind: "xai", label: "xAI", auth: "api-key" },
  { kind: "google", label: "Google", auth: "api-key" },
  { kind: "openrouter", label: "OpenRouter", auth: "api-key" },
  { kind: "ollama", label: "Ollama (local)", auth: "none" },
  {
    kind: "openai-compatible",
    label: "Any OpenAI-compatible server (vLLM, LM Studio, llama.cpp, LocalAI)",
    auth: "optional-key",
  },
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number]["kind"];

export function providerKind(kind: string) {
  return PROVIDER_KINDS.find((k) => k.kind === kind);
}

/** Kinds whose models come from a server the owner runs, not from pi's built-in catalog. */
export const SELF_HOSTED_KINDS: readonly string[] = ["ollama", "openai-compatible"];
