import type { AttachmentDto } from "@shipmate/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { formatBytes } from "../lib/backups.js";
import { ACCEPT, attachmentUrl, fileProblem, filesApi, MAX_FILES } from "../lib/files.js";
import { cx, focusRing } from "./ui.js";

/** Small line icons for the composer (decorative; buttons carry labels). */
export function ComposerIcon({ name }: { name: "clip" | "camera" | "file" }) {
  const paths: Record<typeof name, ReactNode> = {
    clip: (
      <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7" />
    ),
    camera: (
      <>
        <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
        <circle cx="12" cy="13" r="3.5" />
      </>
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v4h4" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export interface PendingFile {
  key: string;
  name: string;
  /** A local preview for photos. */
  preview: string | null;
  state: "uploading" | "ready" | "failed";
  attachment: AttachmentDto | null;
  error: string | null;
}

let seq = 0;

/** Files picked for the next message: uploaded right away, sent with it by id. */
export function useComposerFiles(conversationId: string) {
  const [items, setItems] = useState<PendingFile[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () => () => {
      for (const it of itemsRef.current) if (it.preview) URL.revokeObjectURL(it.preview);
    },
    [],
  );

  const patch = (key: string, p: Partial<PendingFile>) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...p } : it)));

  function add(files: Iterable<File>) {
    const room = MAX_FILES - itemsRef.current.length;
    const picked = [...files].slice(0, Math.max(0, room));
    for (const file of picked) {
      const key = `f${++seq}`;
      const problem = fileProblem(file);
      const preview = !problem && file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      const item: PendingFile = {
        key,
        name: file.name || "photo",
        preview,
        state: problem ? "failed" : "uploading",
        attachment: null,
        error: problem,
      };
      setItems((list) => [...list, item]);
      if (problem) continue;
      filesApi.upload(conversationId, file).then(
        (attachment) => patch(key, { state: "ready", attachment }),
        (err) => patch(key, { state: "failed", error: errorMessage(err) }),
      );
    }
  }

  function remove(key: string) {
    const it = itemsRef.current.find((x) => x.key === key);
    if (!it) return;
    if (it.preview) URL.revokeObjectURL(it.preview);
    if (it.attachment) void filesApi.discard(it.attachment.id).catch(() => {});
    setItems((list) => list.filter((x) => x.key !== key));
  }

  /** After sending: forget the chips (the files now belong to the message). */
  function clear() {
    for (const it of itemsRef.current) if (it.preview) URL.revokeObjectURL(it.preview);
    setItems([]);
  }

  const ready = items.filter((it) => it.state === "ready" && it.attachment);
  return {
    items,
    add,
    remove,
    clear,
    ids: ready.map((it) => it.attachment?.id as string),
    uploading: items.some((it) => it.state === "uploading"),
    full: items.length >= MAX_FILES,
  };
}

/** The paperclip, and on phones a camera button that opens the camera directly. */
export function AttachButtons({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [touch] = useState(() => window.matchMedia?.("(pointer: coarse)").matches === true);
  const button = cx(
    "inline-flex size-[42px] shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800",
    focusRing,
  );
  const pick = (input: HTMLInputElement | null) => {
    if (!input?.files?.length) return;
    onFiles([...input.files]);
    input.value = "";
  };
  return (
    <>
      <button
        type="button"
        className={button}
        disabled={disabled}
        onClick={() => file.current?.click()}
        title="Attach photos or files"
      >
        <ComposerIcon name="clip" />
        <span className="sr-only">Attach photos or files</span>
      </button>
      <input
        ref={file}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => pick(e.currentTarget)}
      />
      {touch && (
        <>
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => camera.current?.click()}
            title="Take a photo"
          >
            <ComposerIcon name="camera" />
            <span className="sr-only">Take a photo</span>
          </button>
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => pick(e.currentTarget)}
          />
        </>
      )}
    </>
  );
}

/** Chips for the files waiting to be sent, with their upload state. */
export function PendingFiles({
  items,
  onRemove,
}: {
  items: PendingFile[];
  onRemove: (key: string) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Files to send">
      {items.map((it) => (
        <li
          key={it.key}
          className={cx(
            "flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-xs",
            it.state === "failed"
              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
              : "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800",
          )}
        >
          {it.preview ? (
            <img src={it.preview} alt="" className="size-8 rounded object-cover" />
          ) : (
            <ComposerIcon name="file" />
          )}
          <span className="min-w-0">
            <span className="block max-w-48 truncate font-medium">{it.name}</span>
            <span className="block text-slate-500 dark:text-slate-400">
              {it.state === "uploading"
                ? "Uploading…"
                : it.state === "failed"
                  ? it.error
                  : formatBytes(it.attachment?.size ?? 0)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(it.key)}
            className={cx("rounded px-1 text-base leading-none hover:bg-black/10", focusRing)}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">Remove {it.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Photos as thumbnails and other files as chips, on a sent message. */
export function MessageFiles({ files, mine = true }: { files: AttachmentDto[]; mine?: boolean }) {
  if (!files.length) return null;
  const images = files.filter((f) => f.kind === "image");
  const others = files.filter((f) => f.kind !== "image");
  return (
    <div className={cx("flex flex-col gap-1.5", mine ? "items-end" : "items-start")}>
      {images.length > 0 && (
        <div className={cx("flex flex-wrap gap-1.5", mine ? "justify-end" : "justify-start")}>
          {images.map((f) => (
            <a
              key={f.id}
              href={attachmentUrl(f.id)}
              target="_blank"
              rel="noreferrer"
              className={cx("block overflow-hidden rounded-xl", focusRing)}
            >
              <img
                src={attachmentUrl(f.id)}
                alt={f.name}
                loading="lazy"
                className="max-h-56 max-w-[min(16rem,70vw)] object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {others.map((f) => (
        <a
          key={f.id}
          href={attachmentUrl(f.id)}
          target="_blank"
          rel="noreferrer"
          className={cx(
            "flex max-w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800",
            focusRing,
          )}
        >
          <ComposerIcon name="file" />
          <span className="max-w-56 truncate font-medium">{f.name}</span>
          <span className="text-slate-500 dark:text-slate-400">
            {f.kind === "pdf" ? "PDF" : "Text"} · {formatBytes(f.size)}
          </span>
        </a>
      ))}
    </div>
  );
}
