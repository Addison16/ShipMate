import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard.js";
import { cx, focusRing } from "./ui.js";

/** A small Copy button that says "Copied" for a moment, sized for a thumb. */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  /** What a screen reader hears, e.g. "Copy code". */
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      onClick={() => {
        copyText(text).then(
          () => setState("copied"),
          () => setState("failed"),
        );
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1800);
      }}
      aria-label={label}
      className={cx(
        "inline-flex min-h-7 items-center gap-1 rounded px-1.5 py-0.5 text-xs",
        focusRing,
        className,
      )}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {state === "copied" ? (
          <path d="M5 12.5l4.5 4.5L19 7" />
        ) : (
          <>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V6a2 2 0 0 1 2-2h9" />
          </>
        )}
      </svg>
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy"}
      </span>
    </button>
  );
}
