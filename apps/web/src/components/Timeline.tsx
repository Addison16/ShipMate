import type { AttachmentDto, MessageDto } from "@shipmate/core";
import type { ReactNode } from "react";
import { messageAttachments } from "../lib/files.js";
import { formatTime } from "../lib/format.js";
import { type Handoff, messageHandoff, type TimelineItem, type ToolChip } from "../lib/timeline.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { MessageFiles } from "./Attachments.js";
import { Avatar } from "./Avatar.js";
import { Markdown } from "./Markdown.js";
import { cx } from "./ui.js";
import { ListenButton } from "./Voice.js";

export function HandoffLine({ handoff }: { handoff: Handoff }) {
  return (
    <div className="my-1 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
      <span className="max-w-[80%] text-center">
        <span className="font-medium text-accent-800 dark:text-accent-300">
          {handoff.from.name} → {handoff.to.name}
        </span>
        {handoff.task && <span>: {handoff.task}</span>}
      </span>
      <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
    </div>
  );
}

function Chip({ chip }: { chip: ToolChip }) {
  return (
    <span
      title={chip.summary}
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
        chip.isError
          ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
          : "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "size-1.5 shrink-0 rounded-full",
          chip.running
            ? "animate-pulse bg-amber-500"
            : chip.isError
              ? "bg-red-500"
              : "bg-emerald-500",
        )}
      />
      <span className="font-mono font-medium">{chip.name}</span>
      {chip.summary && <span className="truncate">{chip.summary}</span>}
      {chip.isError && <span className="sr-only">(failed)</span>}
      {chip.running && <span className="sr-only">(running)</span>}
    </span>
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
    <div className={cx("flex flex-col", mine ? "items-end" : "items-start")}>
      <div className="mb-1 flex items-center gap-2 px-1 text-xs text-slate-500 dark:text-slate-400">
        {!mine && <Avatar name={name} size="sm" />}
        <span className="font-medium text-slate-700 dark:text-slate-200">{name}</span>
        {time && <time>{time}</time>}
        {live && <span className="text-accent-700 dark:text-accent-300">typing…</span>}
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

function MessageView({ message, selfId }: { message: MessageDto; selfId: string }) {
  const a = message.author;
  if (a.kind === "system" || message.role === "system") {
    return (
      <div className="mx-auto max-w-[85%] text-center text-xs text-slate-500 dark:text-slate-400">
        <Markdown text={message.content} />
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
        name={a.kind === "user" ? (mine ? "You" : a.name) : a.name}
        mine={mine}
        time={formatTime(message.createdAt)}
        tools={metaTools(message)}
        actions={
          a.kind === "crew" && message.content ? (
            <ListenButton id={message.id} text={message.content} />
          ) : undefined
        }
        files={files}
      >
        {message.content || !files.length ? <Markdown text={message.content} /> : null}
      </Bubble>
    </>
  );
}

export function TimelineView({ items, selfId }: { items: TimelineItem[]; selfId: string }) {
  return (
    <div className="space-y-4">
      {items.map((it) => {
        if (it.kind === "message") {
          return <MessageView key={it.key} message={it.message} selfId={selfId} />;
        }
        if (it.kind === "handoff") return <HandoffLine key={it.key} handoff={it} />;
        if (it.kind === "approval") return <ApprovalCard key={it.key} approval={it.approval} />;
        return (
          <Bubble key={it.key} name={it.crew.name} mine={false} tools={it.tools} live={!it.done}>
            {it.text ? (
              <Markdown text={it.text} />
            ) : (
              <span className="text-slate-500 dark:text-slate-400">
                <span aria-hidden="true">…</span>
                <span className="sr-only">Thinking</span>
              </span>
            )}
          </Bubble>
        );
      })}
    </div>
  );
}
