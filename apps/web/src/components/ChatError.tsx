import { useId, useState } from "react";
import { cx, ErrorText, focusRing } from "./ui.js";

/** Why the last reply failed, with the provider's own words behind "More details". */
export function ChatError({ message, detail }: { message: string; detail: string | null }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div>
      <ErrorText>{message}</ErrorText>
      {detail && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((o) => !o)}
            className={cx(
              "mt-1 rounded px-1 text-xs font-medium text-slate-600 underline underline-offset-2 dark:text-slate-300",
              focusRing,
            )}
          >
            {open ? "Hide details" : "More details"}
          </button>
          {open && (
            <pre
              id={detailId}
              className="mt-1 max-h-48 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs break-all whitespace-pre-wrap text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
            >
              {detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
