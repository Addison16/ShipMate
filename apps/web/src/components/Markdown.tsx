import { type ReactNode, useMemo } from "react";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown.js";

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
      case "link":
        return (
          <a
            key={key}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-teal-700 underline underline-offset-2 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-200"
          >
            {renderInline(n.children)}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{renderInline(b.children)}</p>;
    case "code":
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-[0.85em] leading-relaxed text-slate-100 dark:bg-black/50"
        >
          <code>{b.text}</code>
        </pre>
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
