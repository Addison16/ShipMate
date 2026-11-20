/**
 * A small code colorer for chat replies: comments, strings, numbers and keywords, for the
 * languages people most often get back. It only splits text into labeled pieces (the renderer
 * turns them into React elements), so nothing from a message is ever injected as HTML. A
 * language it doesn't know stays plain.
 */

export type TokenKind = "comment" | "string" | "number" | "keyword";
export interface Token {
  text: string;
  kind: TokenKind | null;
}

interface Grammar {
  /** Line comment starters, e.g. "//" or "#". */
  line: string[];
  /** Whether slash-star block comments exist. */
  block: boolean;
  /** Quote characters that open a string. */
  quotes: string[];
  keywords: Set<string>;
  /** Keywords match whatever their case (SQL). */
  anyCase?: boolean;
}

const words = (s: string) => new Set(s.split(" "));

const C_LIKE = words(
  "if else for while do switch case default break continue return function class extends new " +
    "const let var import export from as async await try catch finally throw typeof instanceof " +
    "in of this super null undefined true false void static public private protected interface " +
    "type enum implements readonly yield delete int long float double char bool boolean string " +
    "struct package func defer go chan map range fn impl trait pub use mod match mut self crate " +
    "where namespace using final abstract override nil val fun when object sealed data",
);
const PYTHON = words(
  "def class return if elif else for while in not and or is None True False import from as " +
    "try except finally raise with lambda yield pass break continue global nonlocal assert " +
    "async await del self",
);
const SHELL = words(
  "if then else elif fi for while until do done case esac function in return exit export local " +
    "echo cd set unset source sudo",
);
const RUBY = words(
  "def class module end if elsif else unless while until for in do return yield begin rescue " +
    "ensure raise require nil true false self and or not then case when",
);
const SQL = words(
  "select from where insert into values update set delete create table alter drop index join " +
    "left right inner outer on as and or not null is in like order by group having limit offset " +
    "union all distinct primary key foreign references default case when then else end with",
);
const YAML = words("true false null yes no on off");

const c: Grammar = { line: ["//"], block: true, quotes: ['"', "'", "`"], keywords: C_LIKE };
const py: Grammar = { line: ["#"], block: false, quotes: ['"', "'"], keywords: PYTHON };
const sh: Grammar = { line: ["#"], block: false, quotes: ['"', "'"], keywords: SHELL };
const rb: Grammar = { line: ["#"], block: false, quotes: ['"', "'"], keywords: RUBY };
const yaml: Grammar = { line: ["#"], block: false, quotes: ['"', "'"], keywords: YAML };
const sql: Grammar = {
  line: ["--"],
  block: true,
  quotes: ["'", '"'],
  keywords: SQL,
  anyCase: true,
};
const json: Grammar = {
  line: [],
  block: false,
  quotes: ['"'],
  keywords: words("true false null"),
};
const css: Grammar = { line: [], block: true, quotes: ['"', "'"], keywords: new Set() };

const GRAMMARS: Record<string, Grammar> = {
  js: c,
  jsx: c,
  javascript: c,
  ts: c,
  tsx: c,
  typescript: c,
  java: c,
  c: c,
  cpp: c,
  "c++": c,
  cs: c,
  csharp: c,
  go: c,
  golang: c,
  rust: c,
  rs: c,
  kotlin: c,
  swift: c,
  php: c,
  dart: c,
  scala: c,
  py: py,
  python: py,
  sh: sh,
  bash: sh,
  zsh: sh,
  shell: sh,
  console: sh,
  dockerfile: sh,
  rb: rb,
  ruby: rb,
  yaml: yaml,
  yml: yaml,
  toml: yaml,
  ini: yaml,
  sql: sql,
  json: json,
  jsonc: { ...json, line: ["//"], block: true },
  css: css,
  scss: { ...css, line: ["//"] },
};

/** Past this, coloring a block costs more than it helps; it stays plain. */
const MAX_HIGHLIGHT_CHARS = 20_000;

const WORD_RE = /[A-Za-z_$][\w$]*/y;
const NUMBER_RE = /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

/** True when a language name is one this colorer knows. */
export function canHighlight(lang: string): boolean {
  return Object.hasOwn(GRAMMARS, lang.toLowerCase());
}

export function highlight(text: string, lang: string): Token[] {
  const g = Object.hasOwn(GRAMMARS, lang.toLowerCase()) ? GRAMMARS[lang.toLowerCase()] : undefined;
  if (!g || text.length > MAX_HIGHLIGHT_CHARS) return [{ text, kind: null }];
  const out: Token[] = [];
  let plain = "";
  const push = (piece: string, kind: TokenKind | null) => {
    if (!piece) return;
    if (kind === null) {
      plain += piece;
      return;
    }
    if (plain) out.push({ text: plain, kind: null });
    plain = "";
    out.push({ text: piece, kind });
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const starter = g.line.find((s) => text.startsWith(s, i));
    // A "#" only starts a comment at the start of a line or after a space (not in `$#` or a URL).
    if (starter && (starter !== "#" || i === 0 || /\s/.test(text[i - 1] ?? ""))) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      push(text.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    if (g.block && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      push(text.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    if (g.quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j++;
        // Only a backtick string may run over several lines.
        else if (text[j] === "\n" && ch !== "`") break;
        j++;
      }
      const stop = Math.min(text.length, text[j] === ch ? j + 1 : j);
      push(text.slice(i, stop), "string");
      i = stop;
      continue;
    }
    WORD_RE.lastIndex = i;
    const word = WORD_RE.exec(text)?.[0];
    if (word) {
      const key = g.anyCase ? word.toLowerCase() : word;
      push(word, g.keywords.has(key) ? "keyword" : null);
      i += word.length;
      continue;
    }
    NUMBER_RE.lastIndex = i;
    const num = NUMBER_RE.exec(text)?.[0];
    if (num) {
      push(num, "number");
      i += num.length;
      continue;
    }
    push(ch, null);
    i++;
  }
  if (plain) out.push({ text: plain, kind: null });
  return out;
}
