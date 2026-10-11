/**
 * A small markdown-lite parser that produces a plain AST. The renderer turns it into React
 * elements, so text is always escaped by React and no HTML from messages is ever injected.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "quote"; children: Inline[] };

/** Only these schemes become clickable links; anything else (javascript:, data:) stays text. */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u) && !/[\s<>"]/.test(u)) return u;
  return null;
}

const INLINE_RE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  const pushText = (text: string) => {
    if (!text) return;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) out.push({ t: "br" });
      if (!line) return;
      const last = out[out.length - 1];
      if (last && last.t === "text") last.text += line;
      else out.push({ t: "text", text: line });
    });
  };
  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      pushText(rest);
      break;
    }
    pushText(rest.slice(0, m.index));
    if (m[2] !== undefined) {
      out.push({ t: "code", text: m[2].replace(/^ (.*) $/, "$1") });
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push({ t: "strong", children: parseInline(m[3] ?? m[4] ?? "") });
    } else if (m[5] !== undefined && m[6] !== undefined) {
      const href = safeHref(m[6]);
      if (href) out.push({ t: "link", href, children: parseInline(m[5]) });
      else pushText(m[0]);
    } else if (m[7] !== undefined) {
      out.push({ t: "em", children: parseInline(m[7]) });
    } else if (m[8] !== undefined) {
      const href = safeHref(m[8]);
      if (href) out.push({ t: "link", href, children: [{ t: "text", text: m[8] }] });
      else pushText(m[8]);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const FENCE_RE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const UL_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_RE = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const H_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", children: parseInline(para.join("\n")) });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence (or end of input while streaming)
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const h = H_RE.exec(line);
    if (h) {
      flush();
      const level = Math.min(3, (h[1] ?? "#").length) as 1 | 2 | 3;
      blocks.push({ t: "heading", level, children: parseInline(h[2] ?? "") });
      i++;
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      flush();
      const ordered = !ul;
      const start = ol ? Number.parseInt(ol[1] ?? "1", 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = ordered ? OL_RE.exec(l) : UL_RE.exec(l);
        if (m) {
          items.push((ordered ? m[2] : m[1]) ?? "");
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1] += `\n${l.trim()}`;
        } else {
          break;
        }
        i++;
      }
      blocks.push({ t: "list", ordered, start, items: items.map((s) => parseInline(s)) });
      continue;
    }
    const q = QUOTE_RE.exec(line);
    if (q) {
      flush();
      const body: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i] ?? "");
        if (!m) break;
        body.push(m[1] ?? "");
        i++;
      }
      blocks.push({ t: "quote", children: parseInline(body.join("\n")) });
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}
