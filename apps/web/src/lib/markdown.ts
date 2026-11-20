/**
 * A small markdown-lite parser that produces a plain AST. The renderer turns it into React
 * elements, so text is always escaped by React and no HTML from messages is ever injected.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "del"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | {
      t: "list";
      ordered: boolean;
      start: number;
      items: Inline[][];
      /** Set only for a checklist: one entry per item, null for an item with no box. */
      checks?: Array<boolean | null>;
    }
  | { t: "quote"; children: Inline[] }
  | { t: "hr" }
  | { t: "table"; align: Array<TableAlign>; head: Inline[][]; rows: Inline[][][] };

export type TableAlign = "left" | "center" | "right" | null;

/** Only these schemes become clickable links; anything else (javascript:, data:) stays text. */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u) && !/[\s<>"]/.test(u)) return u;
  return null;
}

const INLINE_RE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|~~(?!\s)([^\n]+?)~~/;

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
    } else if (m[9] !== undefined) {
      out.push({ t: "del", children: parseInline(m[9]) });
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
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const CHECK_RE = /^\[([ xX])\]\s+(.*)$/s;
const TABLE_RULE_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of one table row; `\\|` is a literal bar, and bars inside `code` do not split. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cell += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  // The bars at the two ends are optional and add an empty cell each.
  if (cells.length > 1 && !(cells[0] ?? "").trim()) cells.shift();
  if (cells.length > 1 && !(cells[cells.length - 1] ?? "").trim()) cells.pop();
  return cells.map((c) => c.trim());
}

function tableAlign(rule: string): TableAlign[] {
  return splitRow(rule).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

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
    if (HR_RE.test(line)) {
      flush();
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    // A table: a row with a bar, then a rule of dashes with as many columns.
    const rule = lines[i + 1] ?? "";
    if (line.includes("|") && rule.includes("-") && TABLE_RULE_RE.test(rule)) {
      const head = splitRow(line);
      const align = tableAlign(rule);
      if (head.length === align.length && (head.length > 1 || rule.includes("|"))) {
        flush();
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && (lines[i] ?? "").trim() && (lines[i] ?? "").includes("|")) {
          const cells = splitRow(lines[i] ?? "").slice(0, head.length);
          while (cells.length < head.length) cells.push("");
          rows.push(cells.map((c) => parseInline(c)));
          i++;
        }
        blocks.push({ t: "table", align, head: head.map((c) => parseInline(c)), rows });
        continue;
      }
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
      const checks = items.map((s) => CHECK_RE.exec(s));
      if (checks.some(Boolean)) {
        blocks.push({
          t: "list",
          ordered,
          start,
          items: items.map((s, n) => parseInline(checks[n]?.[2] ?? s)),
          checks: checks.map((c) => (c ? c[1] !== " " : null)),
        });
        continue;
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
