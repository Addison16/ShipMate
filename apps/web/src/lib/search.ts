/** Mirrors SEARCH_MARK in @shipmate/core (kept here so the bundle does not pull in zod). */
export const MARK_START = "";
export const MARK_END = "";

/** Split a search snippet into plain and matched parts, for highlighting without HTML. */
export function splitHighlights(snippet: string): Array<{ text: string; mark: boolean }> {
  const parts: Array<{ text: string; mark: boolean }> = [];
  let rest = snippet;
  while (rest) {
    const start = rest.indexOf(MARK_START);
    if (start < 0) {
      parts.push({ text: rest, mark: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), mark: false });
    const end = rest.indexOf(MARK_END, start + 1);
    const stop = end < 0 ? rest.length : end;
    const marked = rest.slice(start + 1, stop);
    if (marked) parts.push({ text: marked, mark: true });
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  // Merge neighbours of the same kind ("a" "b" → "ab").
  return parts.reduce<Array<{ text: string; mark: boolean }>>((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && last.mark === p.mark) last.text += p.text;
    else acc.push({ ...p });
    return acc;
  }, []);
}
