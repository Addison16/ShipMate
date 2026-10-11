/** Telegram's limit on one message's text (counted after entity parsing). */
export const TELEGRAM_LIMIT = 4096;

/** Escape for Telegram's HTML parse mode: only &, < and > are special. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Crew Markdown to Telegram HTML. Everything is escaped first, so nothing the crew writes can
 * break the message; then fenced code becomes <pre>, inline code <code>, and **bold** <b>.
 * Anything else stays as plain text. The visible length never grows, so a piece split at the
 * limit still fits.
 */
export function toTelegramHtml(markdown: string): string {
  return markdown
    .split(/(```[^\n`]*\n?[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^```[^\n`]*\n?/, "").replace(/```$/, "");
        return `<pre>${escapeHtml(body.replace(/\n$/, ""))}</pre>`;
      }
      return part
        .split(/(`[^`\n]+`)/g)
        .map((seg, j) =>
          j % 2 === 1
            ? `<code>${escapeHtml(seg.slice(1, -1))}</code>`
            : escapeHtml(seg).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>"),
        )
        .join("");
    })
    .join("");
}
