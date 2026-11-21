/** What the side panel can show: a page it runs, a document it lays out, or code to read. */
export type PanelKind = "page" | "picture" | "document" | "code";

export interface PanelItem {
  kind: PanelKind;
  title: string;
  lang: string;
  text: string;
}

/** Lines of plain code from which opening it beside the chat is worth a button. */
const LONG_CODE_LINES = 15;

const EXTENSIONS: Record<string, string> = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  python: "py",
  py: "py",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  sql: "sql",
  csv: "csv",
  xml: "xml",
};

export function panelKind(lang: string, text: string): PanelKind {
  const l = lang.trim().toLowerCase();
  const start = text.trimStart().slice(0, 200).toLowerCase();
  if (l === "svg" || (start.startsWith("<svg") && (l === "" || l === "xml" || l === "html"))) {
    return "picture";
  }
  if (
    l === "html" ||
    l === "htm" ||
    start.startsWith("<!doctype html") ||
    start.startsWith("<html")
  ) {
    return "page";
  }
  if (l === "markdown" || l === "md") return "document";
  return "code";
}

/**
 * The panel item for a code block in a reply, or null when the block is better left where it
 * is (a few lines of code). Pages, pictures and documents always open.
 */
export function panelItem(lang: string, text: string): PanelItem | null {
  const kind = panelKind(lang, text);
  if (kind === "code" && text.split("\n").length < LONG_CODE_LINES) return null;
  return { kind, lang: lang.trim().toLowerCase(), text, title: panelTitle(kind, lang, text) };
}

function panelTitle(kind: PanelKind, lang: string, text: string): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);
  if (kind === "page" || kind === "picture") {
    const title = /<title[^<>]{0,200}>([^<]{1,200})<\/title>/i.exec(text)?.[1];
    if (title && clean(title)) return clean(title);
    return kind === "page" ? "Page" : "Picture";
  }
  if (kind === "document") {
    const heading = /^#{1,3}\s+(.{1,200})$/m.exec(text)?.[1];
    return heading ? clean(heading) : "Document";
  }
  return lang.trim() ? `${lang.trim()} code` : "Code";
}

/** A file name to save the item under. */
export function panelFileName(item: PanelItem): string {
  const base =
    item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "file";
  const ext =
    item.kind === "page"
      ? "html"
      : item.kind === "picture"
        ? "svg"
        : item.kind === "document"
          ? "md"
          : (EXTENSIONS[item.lang] ?? "txt");
  return `${base}.${ext}`;
}

/**
 * Rules for a page an agent wrote, shown in a locked frame: its own scripts and styles run, and
 * it may show pictures from the web, but it cannot load scripts from elsewhere or send anything
 * out with fetch, forms or sockets.
 */
const PAGE_RULES =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; " +
  "form-action 'none'; base-uri 'none'";

/** The document the frame shows for a page or picture, with the rules above put first. */
export function panelFrameDocument(item: PanelItem): string {
  const rules = `<meta http-equiv="Content-Security-Policy" content="${PAGE_RULES}">`;
  if (item.kind === "picture") {
    return `<!doctype html><html><head><meta charset="utf-8">${rules}<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%;height:auto}</style></head><body>${item.text}</body></html>`;
  }
  // Straight after the doctype, before any tag the page wrote: the browser opens the head for
  // it there, so the rules are in force before the first script, wherever that script sits.
  const doctype = /^\s*<!doctype[^<>]*>/i.exec(item.text)?.[0] ?? "";
  return `${doctype || "<!doctype html>"}${rules}${item.text.slice(doctype.length)}`;
}
