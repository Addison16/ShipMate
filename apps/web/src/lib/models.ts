/** crew.yaml `model: default`: follow the crew default set in Settings (see @shipmate/core). */
export const CREW_DEFAULT = "default";

const MODEL_LINE = /^model:[ \t]*["']?([^"'#\s]+)["']?[ \t]*(#.*)?$/m;

/** The `model` of a crew.yaml. */
export function readModel(yaml: string): string {
  return MODEL_LINE.exec(yaml)?.[1] ?? "";
}

/** crew.yaml with its top-level `model` set, other lines untouched. */
export function withModel(yaml: string, model: string): string {
  const line = `model: ${model}`;
  if (MODEL_LINE.test(yaml)) return yaml.replace(MODEL_LINE, line);
  return `${yaml.replace(/\s*$/, "")}\n${line}\n`;
}

/** How a crew member's model reads in lists: the default shows what it currently means. */
export function modelLabel(model: string, crewDefault?: string): string {
  if (model !== CREW_DEFAULT) return model;
  return crewDefault ? `Crew default (${crewDefault})` : "Crew default";
}

/** The provider id Claude subscription models use in crew.yaml (`claude-code/sonnet`). */
export const CLAUDE_CODE_PROVIDER = "claude-code";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "ChatGPT plan",
  chatgpt: "ChatGPT plan",
  xai: "xAI",
  google: "Google",
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
  [CLAUDE_CODE_PROVIDER]: "Claude subscription",
};

/** A provider id as people read it. */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

/** The provider part of a model ref (`anthropic/claude-x` → `anthropic`). */
export function providerOf(ref: string): string {
  const i = ref.indexOf("/");
  return i > 0 ? ref.slice(0, i) : "";
}

export interface ModelChoice {
  ref: string;
  name: string;
}

/** Models grouped by provider, in first-seen order. */
export function groupByProvider(
  models: readonly (ModelChoice & { provider?: string })[],
): Map<string, ModelChoice[]> {
  const out = new Map<string, ModelChoice[]>();
  for (const m of models) {
    const p = m.provider ?? providerOf(m.ref);
    const list = out.get(p) ?? [];
    list.push({ ref: m.ref, name: m.name });
    out.set(p, list);
  }
  return out;
}

/**
 * Whether the crew default can run on what this instance is signed in to. When it cannot, crew
 * on the default fall back to the first usable model (as the server does); `fallback` names it.
 */
export function defaultModelStatus(
  defaultModel: string,
  models: ReadonlyArray<{ ref: string; name: string; available: boolean }>,
  claudeSignedIn: boolean,
): { usable: boolean; fallback: string | null } {
  const usable =
    providerOf(defaultModel) === CLAUDE_CODE_PROVIDER
      ? claudeSignedIn
      : models.some((m) => m.ref === defaultModel && m.available);
  if (usable) return { usable, fallback: null };
  const provider = providerOf(defaultModel);
  const fallback =
    models.find((m) => m.available && providerOf(m.ref) === provider) ??
    models.find((m) => m.available);
  return { usable, fallback: fallback?.name ?? null };
}
