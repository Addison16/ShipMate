/** Discord's limit on one message's content. */
export const DISCORD_LIMIT = 2000;

const FENCE = "```";

/**
 * Split text into pieces of at most `limit` characters, preferring paragraph breaks, then line
 * breaks, then spaces. A code block cut in two is closed at the end of one piece and reopened
 * at the start of the next, so both render as code.
 */
export function splitMessage(text: string, limit = DISCORD_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  let reopen = "";
  while (rest) {
    const room = limit - reopen.length;
    if (rest.length <= room) {
      out.push(reopen + rest);
      break;
    }
    // Leave space to close a code block if the cut falls inside one.
    const window = rest.slice(0, room - (FENCE.length + 1));
    const cut = breakAt(window);
    let piece = reopen + rest.slice(0, cut).trimEnd();
    // Drop the separator itself, but keep indentation (it matters inside code blocks).
    rest = rest.slice(cut).replace(/^(\n+| )/, "");
    reopen = "";
    const fences = piece.split(FENCE).length - 1;
    if (fences % 2 === 1) {
      piece += `\n${FENCE}`;
      reopen = `${FENCE}\n`;
    }
    out.push(piece);
  }
  return out.filter((p) => p.trim().length > 0);
}

function breakAt(window: string): number {
  const min = Math.floor(window.length / 3);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(sep);
    if (at > min) return at;
  }
  return window.length;
}
