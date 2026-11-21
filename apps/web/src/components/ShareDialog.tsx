import type { ChatShareDto } from "@shipmate/core";
import { useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { copyText } from "../lib/clipboard.js";
import { formatTime } from "../lib/format.js";
import { shareApi, shareUrl } from "../lib/share.js";
import { Button, ErrorText, Loading } from "./ui.js";

/** Make, copy, update or stop the read-only link to one chat. */
export function ShareDialog({
  conversationId,
  onClose,
  onChanged,
}: {
  conversationId: string;
  onClose: () => void;
  /** Called when the chat became shared or stopped being shared. */
  onChanged: () => void;
}) {
  const [share, setShare] = useState<ChatShareDto | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    shareApi.get(conversationId).then(
      (r) => live && setShare(r.share),
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

  async function run(action: () => Promise<ChatShareDto | null>) {
    setBusy(true);
    setError(null);
    try {
      setShare(await action());
      setCopied(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const make = () => run(async () => (await shareApi.share(conversationId)).share);
  const stop = () =>
    run(async () => {
      await shareApi.stop(conversationId);
      return null;
    });

  const url = share ? shareUrl(share.token) : "";

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
        aria-label="Share this chat"
        className="relative w-full max-w-md space-y-4 rounded-t-2xl border border-slate-200 bg-white p-5 pb-[calc(1.25rem+var(--safe-bottom))] text-left whitespace-normal shadow-2xl sm:rounded-2xl sm:pb-5 dark:border-slate-700 dark:bg-slate-900"
      >
        <h2 className="text-base font-semibold">Share this chat</h2>
        <ErrorText>{error}</ErrorText>
        {share === undefined && !error && <Loading lines={2} />}

        {share === null && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Make a link that shows this chat as it is now. Anyone who has the link can read it
              without signing in. They cannot reply or see anything else.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void make()}>
                {busy ? "Making…" : "Make a link"}
              </Button>
              <Button onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}

        {share && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Anyone who has this link can read the chat up to {formatTime(share.sharedThrough)},
              without signing in.
            </p>
            <code className="block rounded-lg bg-slate-100 px-3 py-2 text-sm break-all select-all dark:bg-slate-800">
              {url}
            </code>
            {share.newer > 0 && (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {share.newer === 1
                  ? "1 newer message is not in the link."
                  : `${share.newer} newer messages are not in the link.`}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() =>
                  void copyText(url).then(
                    () => setCopied(true),
                    () => setError("Could not copy. Select the link and copy it by hand."),
                  )
                }
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
              {share.newer > 0 && (
                <Button disabled={busy} onClick={() => void make()}>
                  Include new messages
                </Button>
              )}
              <Button variant="danger" disabled={busy} onClick={() => void stop()}>
                Stop sharing
              </Button>
              <Button onClick={onClose}>Done</Button>
            </div>
            <details className="text-sm text-slate-500 dark:text-slate-400">
              <summary className="cursor-pointer">More details</summary>
              <p className="mt-2">
                The link shows the words only: no files, pictures you sent, or what tools did. It
                works for people who can reach this address, so someone outside your home network
                needs your Shipmate to be reachable from the internet. Stop sharing or delete the
                chat and the link stops working.
              </p>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
