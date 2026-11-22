import type { AttachmentDto, MessageDto } from "@shipmate/core";
import { type ReactNode, useState } from "react";
import { useCrewName, useThemeText } from "../appearance.js";
import { messageAttachments } from "../lib/files.js";
import { formatTime } from "../lib/format.js";
import { petPreview } from "../lib/pets.js";
import { taskMessage } from "../lib/tasks.js";
import { type Handoff, messageHandoff, type TimelineItem, type ToolChip } from "../lib/timeline.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { MessageFiles } from "./Attachments.js";
import { Avatar } from "./Avatar.js";
import { ChatError } from "./ChatError.js";
import { CopyButton } from "./CopyButton.js";
import { Markdown } from "./Markdown.js";
import { PetPreviewCard } from "./Pet.js";
import { TaskBrief, TaskCard, TaskEnded, TaskResult, TaskSentBack } from "./Tasks.js";
import { ThemeChatCard } from "./ThemeCard.js";
import { cx, focusRing } from "./ui.js";
import { ListenButton } from "./Voice.js";

/** Three dots that bob in turn while a crew member is working on a reply. */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1", className)} aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-typing rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export function HandoffLine({ handoff }: { handoff: Handoff }) {
  const crewName = useCrewName();
  return (
    <div className="my-1 flex animate-fade-in items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
      <span className="max-w-[80%] text-center">
        <span className="font-medium text-accent-800 dark:text-accent-300">
          {crewName(handoff.from.name)} → {crewName(handoff.to.name)}
        </span>
        {handoff.task && <span>: {handoff.task}</span>}
      </span>
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
    </div>
  );
}

function Chip({ chip }: { chip: ToolChip }) {
  // Tap to read the whole line: a phone has no hover, and the line is cut to fit.
  const [open, setOpen] = useState(false);
  const cls = cx(
    "inline-flex max-w-full animate-scale-in gap-1.5 border px-2 py-0.5 text-left text-xs",
    open ? "items-start rounded-lg" : "items-center rounded-full",
    chip.isError
      ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
      : "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  );
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cx(
          "size-1.5 shrink-0 rounded-full",
          open && "mt-1.5",
          chip.running
            ? "animate-pulse bg-amber-500"
            : chip.isError
              ? "bg-red-500"
              : "bg-emerald-500",
        )}
      />
      <span className="shrink-0 font-mono font-medium">{chip.name}</span>
      {chip.summary && (
        <span className={open ? "min-w-0 break-words whitespace-pre-wrap" : "truncate"}>
          {chip.summary}
        </span>
      )}
      {chip.isError && <span className="sr-only">(failed)</span>}
      {chip.running && <span className="sr-only">(running)</span>}
    </>
  );
  if (!chip.summary) return <span className={cls}>{body}</span>;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className={cx(cls, focusRing)}
    >
      {body}
    </button>
  );
}

/** Tool summaries a persisted message may carry in `meta.tools`; read defensively. */
function metaTools(message: MessageDto): ToolChip[] {
  const tools = message.meta?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((t, i): ToolChip[] => {
    if (!t || typeof t !== "object") return [];
    const o = t as Record<string, unknown>;
    const name = o.toolName ?? o.name;
    if (typeof name !== "string") return [];
    return [
      {
        id: typeof o.toolCallId === "string" ? o.toolCallId : String(i),
        name,
        summary: typeof o.summary === "string" ? o.summary : "",
        running: false,
        isError: o.isError === true,
      },
    ];
  });
}

function Bubble({
  name,
  mine,
  time,
  tools,
  children,
  live,
  files = [],
  actions,
}: {
  name: string;
  mine: boolean;
  time?: string;
  tools: ToolChip[];
  children: ReactNode;
  live?: boolean;
  /** Photos and files sent with the message, shown above its text. */
  files?: AttachmentDto[];
  /** Small buttons next to the name (e.g. read aloud). */
  actions?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex flex-col",
        mine ? "animate-msg-in-mine items-end" : "animate-msg-in items-start",
      )}
    >
      <div className="mb-1 flex items-center gap-2 px-1 text-xs text-slate-500 dark:text-slate-400">
        {!mine && <Avatar name={name} size="sm" />}
        <span className="font-medium text-slate-700 dark:text-slate-200">{name}</span>
        {time && <time>{time}</time>}
        {live && (
          <span className="flex items-center gap-1.5 text-accent-700 dark:text-accent-300">
            <TypingDots />
            <span className="sr-only">typing…</span>
          </span>
        )}
        {actions}
      </div>
      {tools.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap gap-1.5">
          {tools.map((t) => (
            <Chip key={t.id} chip={t} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-1.5 max-w-[85%]">
          <MessageFiles files={files} mine={mine} />
        </div>
      )}
      {children !== null && (
        <div
          className={cx(
            "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
            mine
              ? "rounded-tr-sm bg-gradient-to-br from-accent-600 to-accent-700 text-white shadow-sm dark:from-accent-600 dark:to-accent-700 [&_a]:text-white [&_code]:bg-accent-900/50"
              : "rounded-tl-sm border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The small buttons beside a message's name. */
const ACTION =
  "text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200";

function ActionButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex min-h-7 items-center rounded px-1.5 py-0.5 text-xs",
        ACTION,
        focusRing,
      )}
    >
      {children}
    </button>
  );
}

function MessageView({
  message,
  selfId,
  extra,
  onRetry,
}: {
  message: MessageDto;
  selfId: string;
  /** Buttons only the newest messages get (Try again, Edit). */
  extra?: ReactNode;
  /** Set on a "stopped before finishing" note that can be tried again. */
  onRetry?: (() => void) | undefined;
}) {
  const crewName = useCrewName();
  const t = useThemeText();
  const a = message.author;
  if (message.meta?.sessionReset) {
    return (
      <div className="flex items-center gap-3 py-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="h-px min-w-6 flex-1 bg-slate-200 dark:bg-slate-800" />
        <span className="max-w-[75%] text-center">
          {resetNote(message.content, crewName, t)} · {formatTime(message.createdAt)}
        </span>
        <span className="h-px min-w-6 flex-1 bg-slate-200 dark:bg-slate-800" />
      </div>
    );
  }
  const preview = petPreview(message);
  if (preview) return <PetPreviewCard preview={preview} />;
  const question = answeredQuestion(message);
  if (question) return <AnsweredQuestion {...question} />;
  const theme = message.meta?.theme as { id?: unknown } | undefined;
  if (typeof theme?.id === "string") return <ThemeChatCard id={theme.id} />;
  // A job handed over in the background: its card, and the news about it.
  const about = taskMessage(message);
  if (about?.kind === "started") return <TaskCard info={about} />;
  if (about?.kind === "sentBack") return <TaskSentBack info={about} />;
  if (about?.kind === "ended") return <TaskEnded info={about} />;
  if (about?.kind === "brief") return <TaskBrief info={about} />;
  if (message.meta?.turnError === true) {
    // Why a reply never came (it failed, or Shipmate restarted), kept for whoever comes back.
    const detail = message.meta.detail;
    return (
      <div className="mx-auto w-full max-w-[85%]">
        <ChatError
          message={`${t(message.content)} · ${formatTime(message.createdAt)}`}
          detail={typeof detail === "string" ? detail : null}
        />
        {onRetry && (
          <div className="mt-1 flex justify-end">
            <ActionButton onClick={onRetry}>Try again</ActionButton>
          </div>
        )}
      </div>
    );
  }
  if (a.kind === "system" || message.role === "system") {
    return (
      <div className="mx-auto max-w-[85%] text-center text-xs text-slate-500 dark:text-slate-400">
        <Markdown text={t(message.content)} />
      </div>
    );
  }
  const handoff = messageHandoff(message);
  const mine = a.kind === "user" && a.id === selfId;
  const files = messageAttachments(message);
  return (
    <>
      {handoff && <HandoffLine handoff={handoff} />}
      <Bubble
        name={a.kind === "user" ? (mine ? "You" : a.name) : crewName(a.name)}
        mine={mine}
        time={formatTime(message.createdAt)}
        tools={metaTools(message)}
        actions={
          message.content ? (
            <>
              {a.kind === "crew" && <ListenButton id={message.id} text={message.content} />}
              <CopyButton text={message.content} label="Copy message" className={ACTION} />
              {extra}
            </>
          ) : (
            extra
          )
        }
        files={files}
      >
        {about?.kind === "result" ? (
          <TaskResult task={about.task} text={message.content} />
        ) : message.content || !files.length ? (
          <Markdown text={message.content} />
        ) : null}
      </Bubble>
    </>
  );
}

/** "Fresh start. Captain won't remember…" with the name as this person sees it. */
function resetNote(content: string, crewName: (name: string) => string, t: (s: string) => string) {
  const m = /^Fresh start\. (.+) won't remember the messages above\.$/.exec(content);
  if (!m?.[1]) return t(content);
  const who = m[1] === "The crew" ? t("The Crew") : crewName(m[1]);
  return `Fresh start. ${who} won't remember the messages above.`;
}

interface Answered {
  crew: string;
  text: string;
  answer: string | null;
}

function answeredQuestion(m: MessageDto): Answered | null {
  const q = m.meta?.question as
    | { crew?: { name?: unknown }; text?: unknown; answer?: unknown }
    | undefined;
  if (!q || typeof q.text !== "string") return null;
  return {
    crew: typeof q.crew?.name === "string" ? q.crew.name : "The crew",
    text: q.text,
    answer: typeof q.answer === "string" ? q.answer : null,
  };
}

/** A crew member's question and the person's answer, kept in the conversation. */
function AnsweredQuestion({ crew, text, answer }: Answered) {
  const crewName = useCrewName();
  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white/60 px-3.5 py-2.5 text-sm dark:border-slate-800 dark:bg-slate-900/60">
      <p className="text-xs text-slate-600 dark:text-slate-300">{crewName(crew)} asked</p>
      <p className="mt-0.5 break-words text-slate-800 dark:text-slate-100">{text}</p>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-xs text-slate-600 dark:text-slate-300">
        You:
        {answer === null ? (
          <span className="italic">skipped</span>
        ) : (
          <span className="rounded-md bg-accent-100 px-2 py-0.5 text-sm font-medium break-words text-accent-900 dark:bg-accent-500/20 dark:text-accent-100">
            {answer}
          </span>
        )}
      </p>
    </div>
  );
}

/** The last message you sent, when it can be sent again as it was: text only, no files. */
export function lastOwnMessage(items: TimelineItem[], selfId: string): MessageDto | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind !== "message") continue;
    const m = it.message;
    if (m.author.kind !== "user" || m.author.id !== selfId) continue;
    return m.content.trim() && !messageAttachments(m).length ? m : null;
  }
  return null;
}

export function TimelineView({
  items,
  selfId,
  onRetry,
  onEdit,
}: {
  items: TimelineItem[];
  selfId: string;
  /** Send your last message again. Left out while a reply is being written. */
  onRetry?: ((text: string) => void) | undefined;
  /** Put your last message back in the message box to change it. */
  onEdit?: ((text: string) => void) | undefined;
}) {
  const crewName = useCrewName();
  const own = lastOwnMessage(items, selfId);
  const last = items[items.length - 1];
  // Try again sits on the newest thing in the chat, when that is a reply (or a note that the
  // reply failed) to your last message.
  const ownAt = own
    ? items.findIndex((it) => it.kind === "message" && it.message.id === own.id)
    : -1;
  // Once jobs were handed over for it, sending the message again would start them all twice.
  const handedOver = items
    .slice(ownAt + 1)
    .some((it) => it.kind === "message" && taskMessage(it.message) !== null);
  const retryKey =
    own && onRetry && !handedOver && last?.kind === "message" && last.message.id !== own.id
      ? last.key
      : null;
  return (
    <div className="space-y-4">
      {items.map((it) => {
        if (it.kind === "message") {
          const retry =
            it.key === retryKey && own && onRetry ? () => onRetry(own.content) : undefined;
          const failed = it.message.meta?.turnError === true;
          const edit =
            own && onEdit && it.message.id === own.id ? (
              <ActionButton onClick={() => onEdit(own.content)}>Edit</ActionButton>
            ) : null;
          return (
            <MessageView
              key={it.key}
              message={it.message}
              selfId={selfId}
              extra={
                retry && !failed && it.message.author.kind === "crew" ? (
                  <ActionButton onClick={retry}>Try again</ActionButton>
                ) : (
                  edit
                )
              }
              onRetry={failed ? retry : undefined}
            />
          );
        }
        if (it.kind === "handoff") return <HandoffLine key={it.key} handoff={it} />;
        if (it.kind === "approval") return <ApprovalCard key={it.key} approval={it.approval} />;
        return (
          <Bubble
            key={it.key}
            name={crewName(it.crew.name)}
            mine={false}
            tools={it.tools}
            // Before any text the bubble itself shows the dots, so the name row doesn't too.
            live={!it.done && it.text !== ""}
          >
            {it.text ? (
              <Markdown text={it.text} />
            ) : (
              <span className="flex h-6 items-center text-slate-500 dark:text-slate-400">
                <TypingDots />
                <span className="sr-only">Thinking</span>
              </span>
            )}
          </Bubble>
        );
      })}
    </div>
  );
}
