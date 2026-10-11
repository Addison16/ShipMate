/** A short one-line summary of tool arguments or results for the UI and the audit log. */
export function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { content?: Array<{ type: string; text?: string }> }).content;
    const t = content?.find((c) => c.type === "text")?.text ?? "";
    return oneLine(t);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => `${k}: ${String(v)}`);
    return oneLine(entries.join(", "));
  }
  return oneLine(String(value));
}

const oneLine = (s: string) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
};
