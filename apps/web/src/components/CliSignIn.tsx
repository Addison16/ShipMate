import type { CliLoginDto, CliLoginProvider } from "@shipmate/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { cliLoginApi, lastLine } from "../lib/cli-login.js";
import { CopyButton } from "./CopyButton.js";
import { Button, cx, ErrorText, focusRing, Notice, TextField } from "./ui.js";

const SITE: Record<CliLoginProvider, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  gemini: "Google",
};

/**
 * "Sign in" on a Providers card: the server runs the app's own sign-in, and this shows its link
 * (and the code to type or paste) so nobody needs a terminal.
 */
export function CliSignIn({
  provider,
  signedIn,
  onDone,
}: {
  provider: CliLoginProvider;
  signedIn: boolean;
  /** Reload the card's status. */
  onDone: () => void;
}) {
  const [login, setLogin] = useState<CliLoginDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  // Pick up a sign-in that is already running (opened on another device, or a page reload).
  useEffect(() => {
    let live = true;
    cliLoginApi.get(provider).then(
      (r) => live && r.login?.state === "running" && setLogin(r.login),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [provider]);

  const running = login?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      cliLoginApi.get(provider).then(
        (r) => {
          setLogin(r.login);
          if (r.login?.state === "done") done.current();
        },
        () => {},
      );
    }, 1500);
    return () => clearInterval(timer);
  }, [running, provider]);

  async function act(fn: () => Promise<{ login: CliLoginDto | null }>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setLogin(r.login);
      if (r.login?.state === "done") done.current();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = code.trim();
    if (!text) return;
    setSent(login?.output ?? "");
    setCode("");
    void act(() => cliLoginApi.answer(provider, text));
  }

  if (!login || login.state === "cancelled") {
    return (
      <div className="mt-3">
        <ErrorText>{error}</ErrorText>
        <Button
          variant={signedIn ? "secondary" : "primary"}
          disabled={busy}
          onClick={() => {
            setSent(null);
            void act(() => cliLoginApi.start(provider));
          }}
        >
          {signedIn ? "Sign in again" : "Sign in"}
        </Button>
      </div>
    );
  }

  if (login.state === "done") {
    return (
      <div className="mt-3">
        <Notice>Signed in.</Notice>
      </div>
    );
  }

  if (login.state === "failed") {
    return (
      <div className="mt-3 space-y-2">
        <ErrorText>{login.error ?? "The sign-in stopped."}</ErrorText>
        <Button
          disabled={busy}
          onClick={() => {
            setSent(null);
            void act(() => cliLoginApi.start(provider));
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const link = login.links[0];
  const checking = sent !== null && sent === login.output;
  const reply = sent !== null && !checking ? lastLine(login.output) : "";
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <ErrorText>{error}</ErrorText>
      {!link ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">Starting the sign-in…</p>
      ) : (
        <>
          <div>
            <p className="mb-2 text-sm font-medium">1. Sign in with {SITE[provider]}</p>
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(
                "inline-flex items-center justify-center rounded-md bg-accent-700 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-800 dark:bg-accent-600 dark:hover:bg-accent-700",
                focusRing,
              )}
            >
              Open sign-in page
            </a>
          </div>
          {login.code && (
            <div>
              <p className="mb-1 text-sm font-medium">2. Enter this code there</p>
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-slate-100 px-3 py-1.5 font-mono text-lg tracking-widest select-all dark:bg-slate-800">
                  {login.code}
                </span>
                <CopyButton
                  text={login.code}
                  label="Copy code"
                  className="text-slate-600 dark:text-slate-300"
                />
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                This page updates by itself once you finish.
              </p>
            </div>
          )}
          {login.asksForCode && (
            <form onSubmit={onSubmit} className="space-y-2">
              <p className="text-sm font-medium">2. Paste the code it gives you</p>
              <div className="flex items-end gap-2">
                <TextField
                  className="min-w-0 flex-1"
                  label="Code"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button type="submit" variant="primary" disabled={busy || !code.trim()}>
                  Send
                </Button>
              </div>
              {checking && (
                <p className="text-xs text-slate-500 dark:text-slate-400">Checking the code…</p>
              )}
              {reply && <p className="text-xs text-slate-600 dark:text-slate-300">{reply}</p>}
            </form>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void act(() => cliLoginApi.stop(provider))}
        >
          Stop
        </Button>
      </div>
      {login.output.trim() && (
        <details>
          <summary
            className={cx(
              "cursor-pointer rounded text-xs font-medium text-slate-500 dark:text-slate-400",
              focusRing,
            )}
          >
            What it printed
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-100 p-2 text-xs break-all whitespace-pre-wrap dark:bg-slate-800">
            {login.output.trim()}
          </pre>
        </details>
      )}
    </div>
  );
}
