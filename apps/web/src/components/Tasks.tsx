import { isOpenTask, type TaskDto, type TaskRef } from "@shipmate/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { useCrewName } from "../appearance.js";
import { formatTime } from "../lib/format.js";
import {
  isLongResult,
  openSummary,
  openTasks,
  sinceShort,
  type TaskMessage,
  type TaskTone,
  taskState,
  tasksOf,
} from "../lib/tasks.js";
import { href } from "../router.js";
import { useTask, useTasks } from "../tasks.js";
import { Avatar } from "./Avatar.js";
import { Markdown } from "./Markdown.js";
import { Button, cx, ErrorText, focusRing } from "./ui.js";

const TONES: Record<TaskTone, string> = {
  working: "bg-accent-100 text-accent-800 dark:bg-accent-900/60 dark:text-accent-200",
  attention: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  bad: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  muted: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const DOTS: Record<TaskTone, string> = {
  working: "animate-pulse bg-accent-600 dark:bg-accent-400",
  attention: "bg-amber-500",
  good: "bg-emerald-500",
  bad: "bg-red-500",
  muted: "bg-slate-400",
};

/** "Working", "Needs you", "Done"… as a small pill with a dot. */
export function TaskPill({ task }: { task: TaskDto }) {
  const { label, tone } = taskState(task.status);
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
      )}
    >
      <span aria-hidden="true" className={cx("size-1.5 rounded-full", DOTS[tone])} />
      {label}
    </span>
  );
}

const linkButton = cx(
  "inline-flex min-h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 shadow-xs hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
  focusRing,
);

const textLink = cx(
  "rounded font-medium text-accent-800 underline underline-offset-2 dark:text-accent-300",
  focusRing,
);

/** A Stop button for one task, with what went wrong if stopping failed. */
function StopTask({ task }: { task: TaskDto }) {
  const { stop } = useTasks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isOpenTask(task.status)) return null;
  return (
    <>
      <Button
        size="sm"
        variant="danger"
        className="min-h-8"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          stop(task.id)
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Stopping…" : "Stop"}
      </Button>
      {error && (
        <span className="basis-full">
          <ErrorText>{error}</ErrorText>
        </span>
      )}
    </>
  );
}

/** What a task is doing this moment, or how long ago it started or ended. */
function useTaskLine(task: TaskDto | null): string {
  const { activity } = useTasks();
  // Keep "4 min" moving while the card is on screen.
  const [, tick] = useState(0);
  const open = task !== null && isOpenTask(task.status);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [open]);
  if (!task) return "";
  if (task.status === "running") {
    const now = activity[task.conversationId];
    const since = sinceShort(task.startedAt ?? task.createdAt);
    return now ? `${now} · ${since}` : since;
  }
  if (task.status === "waiting") return "Has a question for you";
  if (task.status === "queued") return "Starts when another task ends";
  return formatTime(task.finishedAt ?? task.createdAt);
}

/** The card in the main chat where a job was handed over; it follows the task as it goes. */
export function TaskCard({ info }: { info: Extract<TaskMessage, { kind: "started" }> }) {
  const crewName = useCrewName();
  const task = useTask(info.task.id);
  const line = useTaskLine(task);
  const who = crewName(info.task.crew.name);
  return (
    <section
      aria-label={`Task ${info.task.number}: ${info.task.title}`}
      className="mx-auto w-full max-w-md animate-fade-in rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm shadow-xs dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start gap-2.5">
        <Avatar name={who} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Task {info.task.number} · {who}
          </p>
          <p className="font-medium break-words text-slate-900 dark:text-slate-50">
            {info.task.title}
          </p>
        </div>
        {task && <TaskPill task={task} />}
      </div>
      {info.prompt && info.prompt !== info.task.title && (
        <p className="mt-1.5 line-clamp-2 break-words text-xs text-slate-600 dark:text-slate-300">
          {info.prompt}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <a href={href(`/bridge/${info.task.conversationId}`)} className={linkButton}>
          Open
        </a>
        {task && <StopTask task={task} />}
        {line && (
          <span className="ml-auto min-w-0 truncate text-xs text-slate-600 dark:text-slate-300">
            {line}
          </span>
        )}
      </div>
    </section>
  );
}

/** A thin line across the chat, like a hand-off line, for small task news. */
function TaskLine({ children }: { children: ReactNode }) {
  return (
    <div className="my-1 flex animate-fade-in items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
      <span className="h-px min-w-4 flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
      <span className="max-w-[85%] text-center break-words">{children}</span>
      <span className="h-px min-w-4 flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
    </div>
  );
}

export function TaskSentBack({ info }: { info: Extract<TaskMessage, { kind: "sentBack" }> }) {
  const crewName = useCrewName();
  const from = info.from ? crewName(info.from.name) : "Shipmate";
  return (
    <TaskLine>
      <span className="font-medium text-accent-800 dark:text-accent-300">
        {from} sent task {info.task.number} back to {crewName(info.task.crew.name)}
      </span>
      {info.notes && <span className="line-clamp-2">{info.notes}</span>}
    </TaskLine>
  );
}

export function TaskEnded({ info }: { info: Extract<TaskMessage, { kind: "ended" }> }) {
  const crewName = useCrewName();
  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
      <p className="font-medium break-words">
        {crewName(info.task.crew.name)} could not finish task {info.task.number}: {info.task.title}
      </p>
      {info.error && <p className="mt-0.5 break-words text-xs">{info.error}</p>}
      <a
        href={href(`/bridge/${info.task.conversationId}`)}
        className={cx(
          "mt-1.5 inline-block rounded text-xs font-medium underline underline-offset-2",
          focusRing,
        )}
      >
        Open task
      </a>
    </div>
  );
}

/** In the task's own chat: what was asked, or what was added later. */
export function TaskBrief({ info }: { info: Extract<TaskMessage, { kind: "brief" }> }) {
  const crewName = useCrewName();
  const from = info.from ? crewName(info.from.name) : "Shipmate";
  return (
    <div className="mx-auto w-full max-w-xl rounded-xl border border-slate-200 bg-white/60 px-3.5 py-2.5 text-sm dark:border-slate-800 dark:bg-slate-900/60">
      <p className="text-xs text-slate-600 dark:text-slate-300">
        {info.followUp ? `${from} sent it back` : `${from} asked`}
      </p>
      <Folded text={info.text} />
    </div>
  );
}

/** Long text shown cut, with "Show all". */
function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = isLongResult(text);
  return (
    <>
      <div
        className={cx(
          "break-words",
          long &&
            !open &&
            "max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]",
        )}
      >
        <Markdown text={text} />
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cx("mt-1 text-xs", textLink)}
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

/** A crew member's result in the main chat: the whole reply, folded when it is long. */
export function TaskResult({ task, text }: { task: TaskRef; text: string }) {
  return (
    <>
      <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-slate-600 dark:text-slate-300">
        <span className="min-w-0 break-words">
          Task {task.number} · {task.title}
        </span>
        <a href={href(`/bridge/${task.conversationId}`)} className={textLink}>
          Open task
        </a>
      </p>
      <Folded text={text} />
    </>
  );
}

/** One row of the Tasks list. */
function TaskRow({ task, onOpen }: { task: TaskDto; onOpen: () => void }) {
  const crewName = useCrewName();
  const line = useTaskLine(task);
  const who = crewName(task.crew.name);
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3">
      <a
        href={href(`/bridge/${task.conversationId}`)}
        onClick={onOpen}
        className={cx("flex min-w-0 flex-1 items-start gap-2.5 rounded-md", focusRing)}
      >
        <Avatar name={who} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{task.title}</span>
          <span className="block truncate text-xs text-slate-600 dark:text-slate-300">
            Task {task.number} · {who}
          </span>
          {line && (
            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
              {line}
            </span>
          )}
        </span>
      </a>
      <TaskPill task={task} />
      <StopTask task={task} />
    </li>
  );
}

/** Everything handed over in one chat: what is running first, then what ended. */
export function TasksSheet({
  conversationId,
  open,
  onClose,
}: {
  conversationId: string;
  open: boolean;
  onClose: () => void;
}) {
  const tasks = useTasks();
  const dialog = useRef<HTMLDialogElement>(null);
  const all = tasksOf(tasks, conversationId);
  const running = openTasks(all);
  const ended = all.filter((t) => !isOpenTask(t.status)).reverse();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a modal dialog
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog itself, outside its panel) closes it.
        if (e.target === dialog.current) onClose();
      }}
      aria-labelledby="tasks-sheet-title"
      className="m-auto max-h-[80dvh] w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/40 backdrop:backdrop-blur-[2px] open:flex open:flex-col max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[var(--safe-bottom)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 id="tasks-sheet-title" className="font-semibold">
          Tasks in this chat
        </h2>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {all.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-600 dark:text-slate-300">
            Nothing has been handed over in this chat yet.
          </p>
        )}
        {running.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {running.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={onClose} />
            ))}
          </ul>
        )}
        {ended.length > 0 && (
          <>
            <p className="border-t border-slate-200 px-4 pt-3 text-xs font-medium text-slate-600 dark:border-slate-800 dark:text-slate-300">
              Finished
            </p>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {ended.map((t) => (
                <TaskRow key={t.id} task={t} onOpen={onClose} />
              ))}
            </ul>
          </>
        )}
      </div>
    </dialog>
  );
}

/** "2 tasks working · 1 needs you" above the message box; tap for the list. */
export function TasksStrip({
  conversationId,
  onOpen,
}: {
  conversationId: string;
  onOpen: () => void;
}) {
  const tasks = useTasks();
  const all = tasksOf(tasks, conversationId);
  const summary = openSummary(all);
  const needsYou = all.some((t) => t.status === "waiting");
  if (!summary) return null;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cx(
        "flex min-h-9 w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm",
        needsYou
          ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          : "border-accent-200 bg-accent-50/70 text-accent-900 dark:border-accent-800 dark:bg-accent-950/30 dark:text-accent-100",
        focusRing,
      )}
    >
      <span
        aria-hidden="true"
        className={cx("size-2 shrink-0 rounded-full", needsYou ? DOTS.attention : DOTS.working)}
      />
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      <span className="shrink-0 text-xs font-medium underline underline-offset-2">Show</span>
    </button>
  );
}

/** At the top of a task's own chat: how it stands, the way back, and Stop. */
export function TaskBanner({ task }: { task: TaskDto }) {
  const line = useTaskLine(task);
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/60">
      <a
        href={href(`/bridge/${task.parentConversationId}`)}
        className={cx(
          // Phones already have Back in the row above, which leads to the same place.
          "hidden rounded px-1.5 py-1 text-sm text-slate-700 hover:bg-slate-200/70 md:inline dark:text-slate-200 dark:hover:bg-slate-800",
          focusRing,
        )}
      >
        ← Main chat
      </a>
      <TaskPill task={task} />
      <p className="min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300">
        Task {task.number}
        {line && ` · ${line}`}
      </p>
      <StopTask task={task} />
    </div>
  );
}

/** For a chat's row in the list: says when its tasks are working or need the person. */
export function TaskTag({ conversationId }: { conversationId: string }) {
  const tasks = useTasks();
  const open = openTasks(tasksOf(tasks, conversationId));
  if (!open.length) return null;
  const needs = open.some((t) => t.status === "waiting");
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        needs ? TONES.attention : TONES.working,
      )}
    >
      <span
        aria-hidden="true"
        className={cx("size-1.5 rounded-full", needs ? DOTS.attention : DOTS.working)}
      />
      {needs ? "Needs you" : `${open.length} ${open.length === 1 ? "task" : "tasks"}`}
    </span>
  );
}
