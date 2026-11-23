import type { ChatPeopleDto } from "@shipmate/core";
import { useEffect, useState } from "react";
import { errorMessage, request } from "../api.js";
import { Button, cx, ErrorText, focusRing, Loading } from "./ui.js";

const enc = encodeURIComponent;

export const peopleApi = {
  get: (id: string) => request<ChatPeopleDto>("GET", `/api/conversations/${enc(id)}/people`),
  set: (id: string, userIds: string[]) =>
    request<ChatPeopleDto>("PUT", `/api/conversations/${enc(id)}/people`, { userIds }),
  leave: (id: string) => request<{ ok: true }>("POST", `/api/conversations/${enc(id)}/leave`),
};

/** Who is in a chat. Its starter ticks the people to add; anyone else sees the list and can leave. */
export function PeopleDialog({
  conversationId,
  mine,
  onClose,
  onChanged,
  onLeft,
}: {
  conversationId: string;
  /** The viewer started this chat. */
  mine: boolean;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [data, setData] = useState<ChatPeopleDto | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    peopleApi.get(conversationId).then(
      (d) => {
        if (!live) return;
        setData(d);
        setPicked(new Set(d.people.filter((p) => !p.starter).map((p) => p.id)));
      },
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [conversationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  const save = () =>
    run(async () => {
      await peopleApi.set(conversationId, [...picked]);
      onChanged();
      onClose();
    });
  const leave = () =>
    run(async () => {
      await peopleApi.leave(conversationId);
      onLeft();
    });

  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Close"
        className="slide-over-backdrop absolute inset-0 bg-slate-950/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="People in this chat"
        className="relative max-h-[85dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-5 pb-[calc(1.25rem+var(--safe-bottom))] text-left whitespace-normal shadow-2xl sm:rounded-2xl sm:pb-5 dark:border-slate-700 dark:bg-slate-900"
      >
        <h2 className="text-base font-semibold">People in this chat</h2>
        <ErrorText>{error}</ErrorText>
        {!data && !error && <Loading lines={2} />}

        {data && mine && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Tick who to add. They see everything said here, before and after, and can write too.
            </p>
            {data.household.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                There is nobody else to add yet. The owner adds people under Settings → Users.
              </p>
            ) : (
              <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
                {data.household.map((p) => (
                  <li key={p.id}>
                    <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className={cx("size-5 accent-accent-700", focusRing)}
                        checked={picked.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                      <span className="min-w-0 break-words">{p.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button onClick={onClose}>Cancel</Button>
            </div>
            <details className="text-sm text-slate-500 dark:text-slate-400">
              <summary className="cursor-pointer">More details</summary>
              <p className="mt-2">
                The agent answers whoever wrote last, with that person's permissions, and what it
                costs counts as theirs. Questions and approvals go to that person only. Only you can
                rename, share or delete this chat, or change who is in it.
              </p>
            </details>
          </>
        )}

        {data && !mine && (
          <>
            <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 text-sm dark:divide-slate-700 dark:border-slate-700">
              {data.people.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0 break-words">{p.name}</span>
                  {p.starter && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">started it</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Everyone here sees everything said in this chat.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" disabled={busy} onClick={() => void leave()}>
                Leave chat
              </Button>
              <Button onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
