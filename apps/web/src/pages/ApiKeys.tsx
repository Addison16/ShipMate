import type { ApiKeyDto } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { errorMessage } from "../api.js";
import { NavIcon } from "../components/icons.js";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  PageHeader,
  TextField,
} from "../components/ui.js";
import { apiKeysApi, askExample } from "../lib/api-keys.js";
import { useResource } from "../lib/useResource.js";

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Settings → Other apps: personal keys so Shortcuts, Home Assistant or a script can ask an agent. */
export function ApiKeysPage() {
  const res = useResource(() => apiKeysApi.list().then((r) => r.keys));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = res.data ?? [];
  const origin = window.location.origin;

  async function make(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const made = await apiKeysApi.create(name);
      setFresh({ name: made.key.name, token: made.token });
      setCopied(false);
      setName("");
      res.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  }

  async function remove(k: ApiKeyDto) {
    if (!window.confirm(`Remove "${k.name}"? Anything using this key stops working.`)) return;
    setError(null);
    try {
      await apiKeysApi.remove(k.id);
    } catch (err) {
      setError(errorMessage(err));
    }
    res.reload();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the key and copy it by hand.");
    }
  }

  return (
    <Page>
      <PageHeader
        title="Other apps"
        description="A key lets Siri Shortcuts, Home Assistant or a script message your agents as you."
      />
      <div className="space-y-6">
        <ErrorText>{error ?? res.error}</ErrorText>

        {fresh && (
          <Card>
            <div className="space-y-3">
              <p className="text-sm font-medium">Your key for {fresh.name}</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Copy it now. It is not shown again.
              </p>
              <code className="block rounded-lg bg-slate-100 px-3 py-2 text-sm break-all select-all dark:bg-slate-800">
                {fresh.token}
              </code>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void copy(fresh.token)}>
                  {copied ? "Copied" : "Copy key"}
                </Button>
                <Button onClick={() => setFresh(null)}>Done</Button>
              </div>
            </div>
          </Card>
        )}

        <Card>
          <form onSubmit={make} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <TextField
                label="What is the key for?"
                placeholder="Siri Shortcut"
                maxLength={60}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy ? "Making…" : "Make a key"}
            </Button>
          </form>
        </Card>

        {!res.data && !res.error && <Loading />}
        {res.data && keys.length === 0 && !fresh && (
          <EmptyState icon={<NavIcon name="key" size={22} />} title="No keys yet">
            Make one for each app, so you can remove one without breaking the others.
          </EmptyState>
        )}
        {keys.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-900">
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="min-w-0 flex-1 basis-48">
                  <div className="text-sm font-medium break-words">{k.name}</div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    <code>{k.hint}…</code> · made {day(k.createdAt)} ·{" "}
                    {k.lastUsedAt ? `last used ${day(k.lastUsedAt)}` : "never used"}
                  </p>
                </div>
                <Button size="sm" variant="danger" onClick={() => void remove(k)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <details className="text-sm text-slate-500 dark:text-slate-400">
          <summary className="cursor-pointer">More details</summary>
          <div className="mt-2 space-y-2">
            <p>
              A key can send a message to an agent you can use and read the reply. It cannot open
              your other chats, files or settings. Chats it starts show in your chat list, marked
              "Other app".
            </p>
            <p>Send a message like this:</p>
            <pre className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
              {askExample(origin, fresh?.token ?? "YOUR_KEY")}
            </pre>
            <p>
              The answer comes back as <code>reply</code>. Add <code>"agent"</code> to pick an agent
              and <code>"newChat": true</code> to start over. Steps for Siri Shortcuts and Home
              Assistant are in{" "}
              <a
                className="underline"
                href="https://github.com/Addison16/ShipMate/blob/main/docs/other-apps.md"
                target="_blank"
                rel="noreferrer"
              >
                the guide
              </a>
              .
            </p>
          </div>
        </details>
      </div>
    </Page>
  );
}
