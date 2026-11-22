import { type ReactNode, useMemo } from "react";
import { highlight, type TokenKind } from "../lib/highlight.js";
import { type Block, type Inline, parseMarkdown, type TableAlign } from "../lib/markdown.js";
import { panelItem } from "../lib/side-panel.js";
import { CopyButton } from "./CopyButton.js";
import { useSidePanel } from "./SidePanelContext.js";
import { cx, focusRing } from "./ui.js";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    const key = i;
    switch (n.t) {
      case "text":
        return n.text;
      case "br":
        return <br key={key} />;
      case "code":
        return (
          <code
            key={key}
            className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[0.85em] dark:bg-slate-700/70"
          >
            {n.text}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {renderInline(n.children)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline(n.children)}</em>;
      case "del":
        return <del key={key}>{renderInline(n.children)}</del>;
      case "link":
        return (
          <a
            key={key}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent-700 underline underline-offset-2 hover:text-accent-900 dark:text-accent-300 dark:hover:text-accent-200"
          >
            {renderInline(n.children)}
          </a>
        );
      default:
        return null;
    }
  });
}

const ALIGN: Record<NonNullable<TableAlign> | "none", string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
  none: "text-left",
};

/** Code blocks are always dark, so one set of colors serves light and dark mode. */
const TOKEN: Record<TokenKind, string> = {
  comment: "text-slate-400 italic",
  string: "text-emerald-300",
  number: "text-amber-300",
  keyword: "text-sky-300",
};

export function CodeBlock({
  lang,
  text,
  openable = false,
}: {
  lang: string;
  text: string;
  /** In a chat reply: offer to open a page, document or long code beside the chat. */
  openable?: boolean;
}) {
  const tokens = useMemo(() => highlight(text, lang), [text, lang]);
  const panel = useSidePanel();
  const item = useMemo(
    () => (openable && panel ? panelItem(lang, text) : null),
    [openable, panel, lang, text],
  );
  let offset = 0;
  return (
    <div className="overflow-hidden rounded-md bg-slate-900 text-slate-100 dark:bg-black/50">
      <div className="flex items-center justify-between gap-2 pr-1 pl-3 text-xs text-slate-400">
        <span className="font-mono">{lang || "code"}</span>
        <span className="flex items-center gap-1">
          {item && panel && (
            <button
              type="button"
              onClick={() => panel.open(item)}
              aria-label={`Open ${item.title} beside the chat`}
              className={cx(
                "inline-flex min-h-7 items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium text-white hover:bg-white/10",
                focusRing,
              )}
            >
              {item.kind === "code" ? "Open" : "Open preview"}
            </button>
          )}
          <CopyButton text={text} label="Copy code" className="text-slate-300 hover:bg-white/10" />
        </span>
      </div>
      <pre className="overflow-x-auto px-3 pb-3 font-mono text-[0.85em] leading-relaxed">
        <code>
          {tokens.map((tok) => {
            const k = offset;
            offset += tok.text.length;
            return tok.kind ? (
              <span key={k} className={TOKEN[tok.kind]}>
                {tok.text}
              </span>
            ) : (
              tok.text
            );
          })}
        </code>
      </pre>
    </div>
  );
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{renderInline(b.children)}</p>;
    case "code":
      return <CodeBlock key={key} lang={b.lang} text={b.text} openable />;
    case "hr":
      return <hr key={key} className="border-slate-200 dark:border-slate-700" />;
    case "table":
      return (
        // Wide tables scroll sideways inside the bubble instead of stretching the page.
        <div key={key} className="max-w-full overflow-x-auto">
          <table className="border-collapse text-[0.92em]">
            <thead>
              <tr>
                {b.head.map((cell, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content
                    key={i}
                    className={`border-b border-current/25 px-2.5 py-1.5 font-semibold ${ALIGN[b.align[i] ?? "none"]}`}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content
                <tr key={r} className="border-b border-current/10 last:border-0">
                  {row.map((cell, i) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content
                      key={i}
                      className={`px-2.5 py-1.5 align-top ${ALIGN[b.align[i] ?? "none"]}`}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "heading": {
      const cls = "font-semibold";
      if (b.level === 1)
        return (
          <h3 key={key} className={`text-lg ${cls}`}>
            {renderInline(b.children)}
          </h3>
        );
      if (b.level === 2)
        return (
          <h4 key={key} className={`text-base ${cls}`}>
            {renderInline(b.children)}
          </h4>
        );
      return (
        <h5 key={key} className={cls}>
          {renderInline(b.children)}
        </h5>
      );
    }
    case "list": {
      const checks = b.checks;
      if (checks) {
        return (
          <ul key={key} className="space-y-1">
            {b.items.map((it, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content
              <li key={i} className="flex items-start gap-2">
                {checks[i] === null || checks[i] === undefined ? (
                  <span aria-hidden="true" className="w-4 shrink-0 text-center">
                    •
                  </span>
                ) : (
                  <input
                    type="checkbox"
                    checked={checks[i] === true}
                    readOnly
                    disabled
                    aria-label={checks[i] ? "Done" : "Not done"}
                    className="mt-1.5 size-4 shrink-0 accent-accent-600"
                  />
                )}
                <span className="min-w-0">{renderInline(it)}</span>
              </li>
            ))}
          </ul>
        );
      }
      const items = b.items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content
        <li key={i}>{renderInline(it)}</li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start} className="list-decimal space-y-1 pl-6">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-1 pl-6">
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-slate-300 pl-3 text-slate-600 dark:border-slate-600 dark:text-slate-300"
        >
          {renderInline(b.children)}
        </blockquote>
      );
    default:
      return null;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="space-y-2 break-words">{blocks.map(renderBlock)}</div>;
}
