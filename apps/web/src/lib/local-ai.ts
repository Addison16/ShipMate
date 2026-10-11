import type { LocalAiStatusDto, LocalModelPullDto } from "@shipmate/core";

/** The command that starts the bundled Ollama service next to Shipmate. */
export const LOCAL_AI_COMMAND = "docker compose --profile local-ai up -d";

/** "llama3.2" and "llama3.2:latest" are the same model to Ollama. */
export const withTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export function isInstalled(status: Pick<LocalAiStatusDto, "installed">, name: string): boolean {
  const want = withTag(name.trim());
  return status.installed.some((m) => withTag(m.name) === want);
}

/** The model ref crew.yaml and the default model use for an Ollama model. */
export const ollamaRef = (name: string) => `ollama/${name.trim()}`;

/** Download progress in percent (0–100), or null while Ollama has not said how big it is. */
export function pullPercent(pull: LocalModelPullDto): number | null {
  if (pull.status === "done") return 100;
  if (pull.totalBytes <= 0) return null;
  return Math.min(100, Math.floor((pull.completedBytes / pull.totalBytes) * 100));
}

/** "1.4 GB", "820 MB" (decimal units, as Ollama shows sizes). */
export function formatSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** One line for a pull: "Downloading, 1.2 GB of 2.5 GB (48%)". */
export function pullLabel(pull: LocalModelPullDto): string {
  if (pull.status === "failed") return `Failed: ${pull.error ?? "unknown error"}`;
  if (pull.status === "done") return "Downloaded";
  const p = pullPercent(pull);
  if (p === null) return capitalize(pull.detail || "starting");
  if (p >= 100) return capitalize(pull.detail || "finishing");
  return `Downloading, ${formatSize(pull.completedBytes) || "0 MB"} of ${formatSize(pull.totalBytes)} (${p}%)`;
}

/** The pull for a model, if one is running or just finished. */
export function pullFor(
  status: Pick<LocalAiStatusDto, "pulls">,
  name: string,
): LocalModelPullDto | undefined {
  const want = withTag(name.trim());
  return status.pulls.find((p) => withTag(p.model) === want);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
