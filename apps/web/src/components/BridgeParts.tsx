import type { BridgeLinkCode, UserDto } from "@shipmate/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth, useUser } from "../auth.js";
import { copyText } from "../lib/clipboard.js";
import { formatCountdown, secondsLeft } from "../lib/discord.js";
import { Badge, Button, Card, cx, ErrorText, focusRing, Muted } from "./ui.js";

/** Pieces shared by the Telegram and Slack bridge tabs. */

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cx(
        "rounded font-medium text-accent-800 underline underline-offset-2 dark:text-accent-300",
        focusRing,
      )}
    >
      {children}
    </a>
  );
}

export function StatusCard({
  state,
  error,
  connected,
  busy,
  onReload,
  children,
}: {
  state: { tone: "ok" | "warn" | "danger" | "neutral"; label: string; detail: string };
  error: string | null;
  connected: boolean;
  busy: boolean;
  onReload: () => void;
  children?: ReactNode;
}) {
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          Status <Badge tone={state.tone}>{state.label}</Badge>
        </h2>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onReload}>
          Refresh
        </Button>
      </div>
      <p className="text-sm">{state.detail}</p>
      {connected && error && (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">Last problem: {error}</p>
      )}
      {children}
    </Card>
  );
}

/** A block of text (a manifest, a command) with a Copy button. */
export function CopyBlock({ label, value }: { label: string; value: string }) {
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
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Button size="sm" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed dark:border-slate-700 dark:bg-slate-950">
        {value}
      </pre>
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** "My <app> account": get a one-time link code, watch for the link, or unlink. */
export function LinkAccountCard({
  app,
  field,
  configured,
  createLink,
  unlink,
}: {
  app: string;
  field: "telegramUserId" | "slackUserId";
  configured: boolean;
  createLink: () => Promise<BridgeLinkCode>;
  unlink: () => Promise<unknown>;
}) {
  const user = useUser();
  const { setUser } = useAuth();
  const [code, setCode] = useState<BridgeLinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(code !== null);
  const live = code !== null && secondsLeft(code.expiresAt, now) > 0;
  const linked = user[field];

  // While a code is live, check every few seconds whether the link went through.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      api
        .me()
        .then((me) => {
          if (me.user?.[field]) {
            setUser(me.user);
            setCode(null);
          }
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [live, setUser, field]);

  async function getCode() {
    setBusy(true);
    setError(null);
    try {
      setCode(await createLink());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doUnlink() {
    if (!window.confirm(`Unlink your ${app} account? Messages from it will no longer run.`)) return;
    setBusy(true);
    setError(null);
    try {
      await unlink();
      setUser({ ...user, [field]: null } as UserDto);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">My {app} account</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Link your {app} account so messages you send there run as you. Unlinked accounts only get a
        hint on how to link.
      </p>
      {linked ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            <Badge tone="ok">linked</Badge>{" "}
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{linked}</span>
          </p>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void doUnlink()}>
            Unlink
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {!configured && <Muted>{app} is not set up on this instance yet.</Muted>}
          {code && live ? (
            <div className="space-y-2 rounded-md border border-accent-200 bg-accent-50 p-3 dark:border-accent-900 dark:bg-accent-950/50">
              <p className="text-sm">
                Your code:{" "}
                <code className="rounded bg-white px-2 py-0.5 font-mono text-lg font-semibold tracking-widest dark:bg-slate-900">
                  {code.code}
                </code>
              </p>
              <p className="text-sm break-words">{code.instructions}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400" aria-live="off">
                Expires in {formatCountdown(code.expiresAt, now)}. This page updates once you are
                linked.
              </p>
            </div>
          ) : (
            code && <Muted>That code expired. Get a new one.</Muted>
          )}
          <Button
            variant={code && live ? "secondary" : "primary"}
            disabled={busy || !configured}
            onClick={() => void getCode()}
          >
            {busy ? "Getting a code…" : code && live ? "Get a new code" : "Get a link code"}
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Card>
  );
}
