import { useEffect, useState } from "react";
import { saveTextFile } from "../lib/chat-export.js";
import { panelFileName, panelFrameDocument } from "../lib/side-panel.js";
import { CopyButton } from "./CopyButton.js";
import { CodeBlock, Markdown } from "./Markdown.js";
import { useSidePanel } from "./SidePanelContext.js";
import { cx, focusRing } from "./ui.js";

const tab = (on: boolean) =>
  cx(
    "rounded-md px-2.5 py-1.5 text-sm font-medium",
    focusRing,
    on
      ? "bg-accent-700/10 text-accent-800 dark:bg-accent-400/15 dark:text-accent-200"
      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  );

/**
 * A page, picture, document or long piece of code from a reply, opened beside the chat: a
 * column on a wide screen, the whole screen on a phone. Renders nothing while nothing is open.
 */
export function SidePanel() {
  const panel = useSidePanel();
  const item = panel?.item ?? null;
  const [source, setSource] = useState(false);
  // A newly opened item starts on its preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when another item opens
  useEffect(() => setSource(false), [item]);
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") panel?.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, panel]);
  if (!panel || !item) return null;
  const framed = item.kind === "page" || item.kind === "picture";
  const hasPreview = item.kind !== "code";
  return (
    <section
      data-side-panel
      aria-label={`Opened beside the chat: ${item.title}`}
      className="fixed inset-0 pt-[env(safe-area-inset-top)] lg:pt-0 z-40 flex min-w-0 flex-col bg-white lg:static lg:z-auto lg:w-[46%] lg:max-w-3xl lg:shrink-0 lg:border-l lg:border-slate-200 dark:bg-slate-900 lg:dark:border-slate-800"
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{item.title}</h2>
        <button
          type="button"
          onClick={panel.close}
          className={cx(
            "rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
            focusRing,
          )}
        >
          Close
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
        {hasPreview && (
          <>
            <button
              type="button"
              aria-pressed={!source}
              className={tab(!source)}
              onClick={() => setSource(false)}
            >
              {item.kind === "document" ? "Document" : "Preview"}
            </button>
            <button
              type="button"
              aria-pressed={source}
              className={tab(source)}
              onClick={() => setSource(true)}
            >
              Code
            </button>
          </>
        )}
        <span className="flex-1" />
        <CopyButton
          text={item.text}
          label="Copy"
          className="text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        />
        <button
          type="button"
          className={tab(false)}
          onClick={() => saveTextFile(panelFileName(item), item.text)}
        >
          Save
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" style={{ paddingBottom: "var(--safe-bottom)" }}>
        {framed && !source ? (
          // No same-origin and no network: the page runs on its own, apart from Shipmate.
          <iframe
            title={item.title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={panelFrameDocument(item)}
            className="h-full w-full border-0 bg-white"
          />
        ) : item.kind === "document" && !source ? (
          <div className="mx-auto max-w-prose px-4 py-4 text-[0.95rem] leading-relaxed">
            <Markdown text={item.text} />
          </div>
        ) : (
          <div className="p-2">
            <CodeBlock lang={item.lang} text={item.text} />
          </div>
        )}
      </div>
    </section>
  );
}
