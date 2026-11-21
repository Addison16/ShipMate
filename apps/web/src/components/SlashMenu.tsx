import type { SavedPromptDto } from "@shipmate/core";
import { useEffect, useRef } from "react";
import { href } from "../router.js";
import { cx } from "./ui.js";

export interface SlashItem {
  key: string;
  title: string;
  hint: string;
  pick: () => void;
}

/** Turn the saved prompts that match into menu rows, after the built-in /new. */
export function slashItems(
  query: string,
  prompts: SavedPromptDto[],
  actions: { startFresh: () => void; use: (body: string) => void },
): SlashItem[] {
  const items: SlashItem[] = [];
  if ("new".startsWith(query.trim()) || query.trim() === "") {
    items.push({
      key: "new",
      title: "/new",
      hint: "Start fresh in this chat",
      pick: actions.startFresh,
    });
  }
  for (const p of prompts) {
    items.push({ key: p.id, title: p.title, hint: p.body, pick: () => actions.use(p.body) });
  }
  return items;
}

/** The list that opens above the message box while the message is just "/…". */
export function SlashMenu({ items, active }: { items: SlashItem[]; active: number }) {
  const list = useRef<HTMLDivElement>(null);
  // The message box keeps the focus, so the browser does not bring the chosen row into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chosen row changes
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Saved prompts"
      className="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
    >
      {items.map((item, i) => (
        <button
          key={item.key}
          type="button"
          role="option"
          aria-selected={i === active}
          // Keep the keyboard open on phones: the message box must not lose focus.
          onMouseDown={(e) => e.preventDefault()}
          onClick={item.pick}
          className={cx(
            "block w-full rounded-lg px-3 py-2 text-left text-sm",
            i === active
              ? "bg-accent-50 dark:bg-accent-950/60"
              : "hover:bg-slate-50 dark:hover:bg-slate-800",
          )}
        >
          <span className="block font-medium">{item.title}</span>
          <span className="block truncate text-slate-500 dark:text-slate-400">{item.hint}</span>
        </button>
      ))}
      <a
        href={href("/prompts")}
        className="block rounded-lg px-3 py-2 text-sm text-accent-700 hover:bg-slate-50 dark:text-accent-300 dark:hover:bg-slate-800"
      >
        {items.length <= 1 ? "Save a prompt to reuse it here" : "Manage saved prompts"}
      </a>
    </div>
  );
}
