import type { WebSearchSettingsDto, WebSearchSource } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { errorMessage, request } from "../api.js";
import { useUser } from "../auth.js";
import { useResource } from "../lib/useResource.js";
import { Button, Card, ErrorText, TextField } from "./ui.js";

const webApi = {
  get: () => request<{ web: WebSearchSettingsDto }>("GET", "/api/settings/web"),
  save: (body: Partial<WebSearchSettingsDto>) =>
    request<{ web: WebSearchSettingsDto }>("PUT", "/api/settings/web", body),
  test: (source: WebSearchSource, searxngUrl: string) =>
    request<{ ok: boolean; message: string }>("POST", "/api/settings/web/test", {
      source,
      searxngUrl,
    }),
};

const SOURCES: Array<{ value: WebSearchSource; label: string; hint: string }> = [
  { value: "duckduckgo", label: "DuckDuckGo", hint: "Nothing to set up." },
  { value: "searxng", label: "My own SearXNG", hint: "Private and steadier." },
  { value: "off", label: "Off", hint: "Agents cannot search the web." },
];

/** Settings → General: the built-in web search and page reading every agent gets. */
export function WebSearchSettings() {
  const user = useUser();
  const admin = user.role === "owner" || user.role === "admin";
  const res = useResource(() => webApi.get().then((r) => r.web));
  const [source, setSource] = useState<WebSearchSource>("duckduckgo");
  const [address, setAddress] = useState("");
  const [readPages, setReadPages] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!res.data) return;
    setSource(res.data.source);
    setAddress(res.data.searxngUrl);
    setReadPages(res.data.readPages);
  }, [res.data]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      res.setData((await webApi.save({ source, searxngUrl: address, readPages })).web);
      setNote({ ok: true, message: "Saved" });
    });
  };
  const test = () => void run(async () => setNote(await webApi.test(source, address)));

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Web search</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Lets every agent look things up on the web.
      </p>
      <ErrorText>{res.error}</ErrorText>
      {res.data && (
        <form onSubmit={save} className="space-y-4">
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 font-medium">Search with</legend>
            {SOURCES.map((o) => (
              <label key={o.value} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="web-search-source"
                  className="mt-0.5 size-4 accent-accent-600"
                  disabled={!admin}
                  checked={source === o.value}
                  onChange={() => setSource(o.value)}
                />
                <span>
                  {o.label}
                  <span className="block text-slate-500 dark:text-slate-400">{o.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {source === "searxng" && (
            <TextField
              label="SearXNG address"
              placeholder="http://192.168.1.10:8080"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              disabled={!admin}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-accent-600"
              disabled={!admin}
              checked={readPages}
              onChange={(e) => setReadPages(e.target.checked)}
            />
            Let agents read public web pages
          </label>
          <details className="text-sm text-slate-500 dark:text-slate-400">
            <summary className="cursor-pointer">More details</summary>
            <p className="mt-2">
              DuckDuckGo has no official search service for apps, so Shipmate reads its normal
              results page. It can stop answering for a while when it gets many searches; your own
              SearXNG is steadier. SearXNG must allow JSON: in its settings.yml, add{" "}
              <code>json</code> under <code>search</code> → <code>formats</code>, then restart it.
              Agents can only read pages on the public web. Addresses on your home network are
              always refused.
            </p>
          </details>
          <ErrorText>{error}</ErrorText>
          {note && (
            <p
              className={
                note.ok
                  ? "text-sm text-emerald-700 dark:text-emerald-300"
                  : "text-sm text-red-700 dark:text-red-300"
              }
            >
              {note.message}
            </p>
          )}
          {admin && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" disabled={busy}>
                Save
              </Button>
              <Button
                disabled={busy || source === "off" || (source === "searxng" && !address.trim())}
                onClick={test}
              >
                Test search
              </Button>
            </div>
          )}
        </form>
      )}
    </Card>
  );
}
