/** Mirrors MAX_BUNDLE_BYTES on the server. */
export const MAX_CREW_FILE_BYTES = 512 * 1024;

/** A reason not to read this file as a crew file, or null when it looks fine. */
export function checkCrewFile(file: { name: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_CREW_FILE_BYTES)
    return "That file is too large for a crew member (512 KB at most).";
  if (!/\.json$/i.test(file.name)) return "Pick a .shipmate-crew.json file.";
  return null;
}

/** "Exported 1 value that looked like a key…" from the X-Shipmate-Redacted header, or null. */
export function redactedNotice(header: string | null): string | null {
  const n = Number(header ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n} value${n === 1 ? "" : "s"} that looked like a key or token ${n === 1 ? "was" : "were"} replaced with [redacted] in the file.`;
}
