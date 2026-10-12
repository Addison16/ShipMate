import { type ReactNode, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard.js";
import { Button, cx, focusRing } from "./ui.js";

/** A read-only value with a Copy button. */
export function CopyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    try {
      await copyText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div>
      <p className="mb-1 text-sm font-medium">{label}</p>
      <div className="flex gap-2">
        <input
          readOnly
          aria-label={label}
          value={value}
          onFocus={(e) => e.target.select()}
          className={cx(
            "min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-800",
            focusRing,
          )}
        />
        <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}
