import { lazy, Suspense, useState } from "react";
import { errorMessage } from "../api.js";
import { terminalApi } from "../lib/cli-login.js";
import { useResource } from "../lib/useResource.js";
import { href } from "../router.js";
import { Badge, Button, Card, ErrorText, Loading, Muted } from "./ui.js";

const TerminalView = lazy(() => import("./TerminalView.js"));

/** Settings > Terminal (owner): turn the web terminal on or off, and open it. */
export function TerminalSettings() {
  const res = useResource(() => terminalApi.status().then((r) => r.terminal));
  const [agree, setAgree] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = res.data;

  async function set(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      res.setData((await terminalApi.set(enabled)).terminal);
      if (!enabled) setOpen(false);
      setAgree(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!s) return res.error ? <ErrorText>{res.error}</ErrorText> : <Loading lines={2} />;

  return (
    <>
      <Card>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Web terminal</h2>
          <Badge tone={s.enabled ? "warn" : "neutral"}>{s.enabled ? "On" : "Off"}</Badge>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Run commands on the Shipmate server from here, like{" "}
          <code className="font-mono text-xs">docker exec</code>. To sign in to Claude, Codex or
          Gemini, use{" "}
          <a className="underline" href={href("/providers")}>
            Providers
          </a>{" "}
          instead.
        </p>
        <ErrorText>{error}</ErrorText>
        {!s.allowed ? (
          <div className="mt-3">
            <Muted>
              Kept off by the server setting{" "}
              <code className="font-mono text-xs">SHIPMATE_TERMINAL=off</code>.
            </Muted>
          </div>
        ) : !s.enabled ? (
          <div className="mt-3 space-y-3">
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
              Anyone signed in as you could run any command on the server and read all of Shipmate's
              data. Turn it on only when you need it.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
              />
              I understand
            </label>
            <Button variant="primary" disabled={!agree || busy} onClick={() => void set(true)}>
              Turn on
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {!open && (
              <Button variant="primary" onClick={() => setOpen(true)}>
                Open terminal
              </Button>
            )}
            <Button variant="danger" disabled={busy} onClick={() => void set(false)}>
              Turn off
            </Button>
          </div>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer rounded text-sm font-medium text-slate-600 dark:text-slate-300">
            More details
          </summary>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Only the owner can open it. Each time it opens is in the Audit log. It closes after 30
            minutes with no typing. To keep it off for good, set{" "}
            <code className="font-mono text-xs">SHIPMATE_TERMINAL=off</code> on the container.
          </p>
        </details>
      </Card>
      {s.enabled && open && (
        <Suspense fallback={<Loading lines={4} label="Opening the terminal…" />}>
          <TerminalView onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
