/**
 * Room for one message's text. Slack accepts far more, but cuts long messages off in the
 * client, and its guidance is to stay under 4,000 characters.
 */
export const SLACK_LIMIT = 3_900;

/** Escape for mrkdwn: only &, < and > are special (they start links and mentions). */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Crew Markdown to Slack mrkdwn: everything escaped (so no stray mention or link), then
 * **bold** → *bold*, [text](https://…) → a link and "# Heading" → *Heading*, outside code.
 * Code blocks and inline code are already the same in both.
 */
export function toMrkdwn(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return escapeMrkdwn(part);
      return part
        .split(/(`[^`\n]+`)/g)
        .map((seg, j) =>
          j % 2 === 1
            ? escapeMrkdwn(seg)
            : escapeMrkdwn(seg)
                .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
                .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
                .replace(
                  /\[([^\]\n]+)\]\((https?:\/\/[^\s)|]+)\)/g,
                  (_m, label: string, url: string) => `<${url}|${label.replaceAll("|", "¦")}>`,
                ),
        )
        .join("");
    })
    .join("");
}

/** A crew avatar as a Slack icon: an https image, or a ":emoji:" name. */
export function slackIcon(avatar: string | null | undefined): {
  iconUrl?: string;
  iconEmoji?: string;
} {
  const a = avatar?.trim();
  if (!a) return {};
  if (/^https:\/\/\S+$/.test(a)) return { iconUrl: a };
  if (/^:[a-z0-9_+-]+:$/.test(a)) return { iconEmoji: a };
  return {};
}
