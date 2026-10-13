import type { ApprovalDto } from "@shipmate/core";
import { useId, useState } from "react";
import { useApprovals } from "../approvals.js";
import { resolutionLabel } from "../lib/approvals.js";
import { formatTime } from "../lib/format.js";
import { Button, cx, ErrorText, focusRing } from "./ui.js";

/** Tools a person approves every time; "always allow" is not offered for them. */
const EVERY_TIME = new Set(["approve_crew_member"]);

/** A pending tool approval with Allow once / Always allow / Deny, or how it ended. */
export function ApprovalCard({ approval, compact }: { approval: ApprovalDto; compact?: boolean }) {
  const { pending, answering, resolved, errors, answer } = useApprovals();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const isPending = pending.some((a) => a.id === approval.id);
  const busy = answering.includes(approval.id);

  if (!isPending) {
    const r = resolved[approval.id];
    return (
      <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
        <span className="max-w-[80%] text-center">
          <span className="font-mono">{approval.toolName}</span> for {approval.crew.name}:{" "}
          <span
            className={cx(
              "font-medium",
              r === "deny"
                ? "text-red-700 dark:text-red-300"
                : r === "allow" || r === "always"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : undefined,
            )}
          >
            {resolutionLabel(r, approval.crew.name)}
          </span>
        </span>
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
      </div>
    );
  }

  return (
    <section
      aria-label={`Approval needed: ${approval.crew.name} wants to run ${approval.toolName}`}
      className={cx(
        "rounded-lg border border-amber-300 bg-amber-50 text-sm dark:border-amber-800 dark:bg-amber-950/40",
        compact ? "p-3" : "p-4",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-amber-950 dark:text-amber-100">
          {approval.crew.name} wants to run{" "}
          <span className="font-mono text-[0.95em]">{approval.toolName}</span>
        </p>
        <time className="text-xs text-amber-800 dark:text-amber-200">
          {formatTime(approval.createdAt)}
        </time>
      </div>
      {approval.summary && (
        <p className="mt-1 break-words text-amber-900 dark:text-amber-100/90">{approval.summary}</p>
      )}
      {approval.detail && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((o) => !o)}
            className={cx(
              "rounded text-xs font-medium text-amber-900 underline underline-offset-2 dark:text-amber-200",
              focusRing,
            )}
          >
            {open ? "Hide details" : "Show details"}
          </button>
          {open && (
            <pre
              id={detailId}
              className="mt-2 max-h-72 overflow-auto rounded border border-amber-200 bg-white p-2 font-mono text-xs whitespace-pre-wrap text-slate-800 dark:border-amber-900 dark:bg-slate-950 dark:text-slate-200"
            >
              {approval.detail}
            </pre>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => void answer(approval.id, "allow")}
        >
          Allow once
        </Button>
        {!EVERY_TIME.has(approval.toolName) && (
          <Button size="sm" disabled={busy} onClick={() => void answer(approval.id, "always")}>
            Always allow for {approval.crew.name}
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => void answer(approval.id, "deny")}
        >
          Deny
        </Button>
        {busy && (
          <span className="self-center text-xs text-amber-900 dark:text-amber-200">Sending…</span>
        )}
      </div>
      {errors[approval.id] && (
        <div className="mt-2">
          <ErrorText>{errors[approval.id]}</ErrorText>
        </div>
      )}
    </section>
  );
}
