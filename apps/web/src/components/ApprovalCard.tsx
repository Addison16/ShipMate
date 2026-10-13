import type { ApprovalDto } from "@shipmate/core";
import { type FormEvent, useId, useState } from "react";
import { useApprovals } from "../approvals.js";
import { resolutionLabel } from "../lib/approvals.js";
import { formatTime } from "../lib/format.js";
import { Button, cx, ErrorText, focusRing } from "./ui.js";

/**
 * A pending tool approval with Allow once / Always allow / Deny (or Approve / Decline for what
 * is asked every time), a crew member's question with tap-to-answer choices, or how it ended.
 */
export function ApprovalCard({ approval, compact }: { approval: ApprovalDto; compact?: boolean }) {
  const { pending, answering, resolved, errors, answer } = useApprovals();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const isPending = pending.some((a) => a.id === approval.id);
  const busy = answering.includes(approval.id);
  const everyTime = approval.everyTime || approval.toolName === "approve_crew_member";

  if (approval.question) {
    // Once answered, the note the crew member leaves in the conversation shows the answer.
    return isPending ? <QuestionCard approval={approval} compact={compact} /> : null;
  }

  if (!isPending) {
    const r = resolved[approval.id];
    return (
      <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
        <span className="max-w-[80%] text-center">
          {everyTime ? (
            approval.summary
          ) : (
            <>
              <span className="font-mono">{approval.toolName}</span> for {approval.crew.name}
            </>
          )}
          :{" "}
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
            {resolutionLabel(r, approval.crew.name, everyTime)}
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
          {everyTime ? (
            `${approval.crew.name} is asking first`
          ) : (
            <>
              {approval.crew.name} wants to run{" "}
              <span className="font-mono text-[0.95em]">{approval.toolName}</span>
            </>
          )}
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
            {open ? "Hide details" : "More details"}
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
          {everyTime ? "Approve" : "Allow once"}
        </Button>
        {!everyTime && (
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
          {everyTime ? "Decline" : "Deny"}
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

/** A crew member's question: tap a choice, type your own answer, or skip it. */
function QuestionCard({ approval, compact }: { approval: ApprovalDto; compact?: boolean }) {
  const { answering, errors, answer } = useApprovals();
  const [own, setOwn] = useState<string | null>(null);
  const ownId = useId();
  const busy = answering.includes(approval.id);
  const question = approval.question;
  if (!question) return null;

  const submitOwn = (e: FormEvent) => {
    e.preventDefault();
    const text = own?.trim();
    if (text) void answer(approval.id, "allow", text);
  };

  return (
    <section
      aria-label={`${approval.crew.name} asks: ${question.text}`}
      className={cx(
        "animate-fade-in rounded-xl border border-accent-200 bg-accent-50/70 text-sm dark:border-accent-800 dark:bg-accent-950/30",
        compact ? "p-3" : "p-4",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-accent-800 dark:text-accent-200">
          {approval.crew.name} asks
        </p>
        <time className="text-xs text-slate-600 dark:text-slate-300">
          {formatTime(approval.createdAt)}
        </time>
      </div>
      <p className="mt-1 text-[0.95rem] font-medium break-words text-slate-900 dark:text-slate-50">
        {question.text}
      </p>
      <ul className="mt-3 grid gap-2">
        {question.options.map((o) => (
          <li key={o.label}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void answer(approval.id, "allow", o.label)}
              className={cx(
                "flex min-h-11 w-full flex-col justify-center rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-left shadow-xs transition duration-150 ease-out hover:border-accent-400 hover:bg-accent-50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-accent-500 dark:hover:bg-slate-800",
                focusRing,
              )}
            >
              <span className="font-medium text-slate-900 dark:text-slate-100">{o.label}</span>
              {o.detail && (
                <span className="text-xs text-slate-600 dark:text-slate-300">{o.detail}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {own === null ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOwn("")}>
            Something else…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void answer(approval.id, "deny")}
          >
            Skip
          </Button>
        </div>
      ) : (
        <form onSubmit={submitOwn} className="mt-2 flex gap-2">
          <label htmlFor={ownId} className="sr-only">
            Your answer
          </label>
          <input
            id={ownId}
            // biome-ignore lint/a11y/noAutofocus: opened by the person to type right away
            autoFocus
            value={own}
            maxLength={2000}
            disabled={busy}
            onChange={(e) => setOwn(e.target.value)}
            placeholder="Type your answer"
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-500 focus:border-accent-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-400 sm:text-sm"
          />
          <Button type="submit" variant="primary" disabled={busy || !own.trim()}>
            Send
          </Button>
        </form>
      )}
      {busy && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">Sending…</p>}
      {errors[approval.id] && (
        <div className="mt-2">
          <ErrorText>{errors[approval.id]}</ErrorText>
        </div>
      )}
    </section>
  );
}
