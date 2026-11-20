import type { MessageDto } from "@shipmate/core";

/** A conversation as a Markdown file: who said what and when, without the app's own notes. */
export function chatMarkdown(
  title: string,
  messages: MessageDto[],
  options: { selfId: string; crewName?: (name: string) => string; locale?: string } = {
    selfId: "",
  },
): string {
  const name = options.crewName ?? ((n: string) => n);
  const out = [`# ${title.replace(/\s+/g, " ").trim() || "Chat"}`, ""];
  for (const m of messages) {
    if (m.author.kind === "system" || m.role === "system") {
      if (m.meta?.sessionReset) out.push("---", "");
      continue;
    }
    const files = Array.isArray(m.meta?.attachments)
      ? (m.meta.attachments as Array<{ name?: unknown }>)
          .map((f) => (typeof f.name === "string" ? f.name : ""))
          .filter(Boolean)
      : [];
    if (!m.content.trim() && !files.length) continue;
    const who =
      m.author.kind === "user"
        ? m.author.id === options.selfId
          ? "You"
          : m.author.name
        : name(m.author.name);
    const when = new Date(m.createdAt).toLocaleString(options.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    out.push(`**${who}** · ${when}`, "");
    if (files.length) out.push(`_Attached: ${files.join(", ")}_`, "");
    if (m.content.trim()) out.push(m.content.trim(), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** A safe file name from a chat's title: "Plan dinners for next week.md". */
export function chatFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 80);
  return `${base || "chat"}.md`;
}

/** Hand the person a text file to save. */
export function saveTextFile(name: string, text: string, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
