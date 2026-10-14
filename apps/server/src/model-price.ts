import type { Api, Model } from "@earendil-works/pi-ai";
import { splitModelRef } from "@shipmate/crew";

/** How much of a Claude subscription's limits each model family uses, in plain words. */
const CLAUDE_SIZES: Array<[RegExp, string]> = [
  [/opus/i, "Claude subscription, largest model (uses its limits fastest)"],
  [/sonnet/i, "Claude subscription, mid-size model"],
  [/haiku/i, "Claude subscription, smallest model (uses its limits slowest)"],
];

/** The Claude subscription's models, as crew.yaml refs. */
const CLAUDE_CODE_REFS = ["claude-code/haiku", "claude-code/sonnet", "claude-code/opus"];

const usd = (n: number) =>
  n >= 1 ? n.toFixed(2).replace(/\.00$/, "") : String(Number(n.toPrecision(2)));

/**
 * What a model costs in a few words, so the Captain can hand work to the cheapest crew member
 * that can do it: a price per million tokens, or how a Claude subscription model uses its limits.
 */
export function modelPrice(ref: string, available: Model<Api>[]): string {
  const r = splitModelRef(ref);
  if (!r) return "unknown model";
  if (r.provider === "claude-code") {
    return CLAUDE_SIZES.find(([re]) => re.test(r.id))?.[1] ?? "Claude subscription";
  }
  if (r.provider === "codex") return "ChatGPT plan through Codex";
  if (r.provider === "cursor") return "Cursor plan";
  if (r.provider === "gemini-cli") return "Gemini CLI (API key or work login)";
  const m = available.find((x) => x.provider === r.provider && x.id === r.id);
  if (!m) return "not set up";
  const { input, output } = m.cost;
  if (!input && !output) return "no per-token price";
  return `$${usd(input)} in / $${usd(output)} out per million tokens`;
}

/** At most this many models in list_models; providers like OpenRouter offer hundreds. */
const MAX_LISTED = 40;

/**
 * list_models: usable models cheapest first, then the Claude subscription's models when it is in
 * use (`withClaudeCode`) and the Codex, Cursor and Gemini CLI models given, one
 * `- ref: name, price` line each.
 */
export function modelList(
  available: Model<Api>[],
  withClaudeCode: boolean,
  cliModels: ReadonlyArray<{ ref: string; name: string }> = [],
): string {
  const priced = [...available].sort(
    (a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output),
  );
  const lines = priced
    .slice(0, MAX_LISTED)
    .map(
      (m) =>
        `- ${m.provider}/${m.id}: ${m.name}, ${modelPrice(`${m.provider}/${m.id}`, available)}`,
    );
  if (priced.length > MAX_LISTED)
    lines.push(`(${priced.length - MAX_LISTED} pricier models not shown)`);
  if (withClaudeCode) {
    lines.push(...CLAUDE_CODE_REFS.map((ref) => `- ${ref}: ${modelPrice(ref, available)}`));
  }
  lines.push(...cliModels.map((m) => `- ${m.ref}: ${m.name}, ${modelPrice(m.ref, available)}`));
  return lines.join("\n");
}
