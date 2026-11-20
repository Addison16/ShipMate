import type { BackupDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { useUser } from "../auth.js";
import {
  backupDownloadUrl,
  backupsApi,
  describeHour,
  formatBytes,
  TRIGGER_LABEL,
} from "../lib/backups.js";
import { useResource } from "../lib/useResource.js";
import { Badge, Button, Card, ErrorText, SelectField, TextField } from "./ui.js";

/** Poll until Shipmate answers again after a restart (it goes away first), or give up. */
async function waitForRestart(tries = 90): Promise<void> {
  await new Promise((r) => setTimeout(r, 4000));
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch("/healthz", { cache: "no-store" });
      if (res.ok) return;
    } catch {
      // Still down.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Settings → Backups (owner only): back up now, download or delete, nightly schedule. */
export function BackupSettings() {
  const user = useUser();
  if (user.role !== "owner") return null;
  return <BackupSettingsCard />;
}

function BackupSettingsCard() {
  const res = useResource(() => backupsApi.list());
  const [hour, setHour] = useState("off");
  const [keep, setKeep] = useState("7");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    const s = res.data?.settings;
    if (!s) return;
    setHour(s.hourUtc === null ? "off" : String(s.hourUtc));
    setKeep(String(s.keep));
  }, [res.data?.settings]);

  async function backUpNow() {
    setRunning(true);
    setError(null);
    try {
      await backupsApi.create();
      await res.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  async function remove(b: BackupDto) {
    if (!window.confirm(`Delete ${b.name}? This cannot be undone.`)) return;
    setError(null);
    try {
      await backupsApi.remove(b.name);
      await res.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function restore(b: BackupDto) {
    const typed = window.prompt(
      `Restore ${new Date(b.createdAt).toLocaleString()}?\n\nEverything changed since then is replaced: chats, agents, settings and files. A backup of how things are now is made first. Shipmate then restarts, which takes about a minute.\n\nType RESTORE to go ahead.`,
    );
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== "RESTORE") {
      setError("Nothing was restored. Type RESTORE to confirm.");
      return;
    }
    setError(null);
    setRestoring(b.name);
    try {
      await backupsApi.restore(b.name, typed);
      // Shipmate is restarting; wait for it, then load the restored state.
      await waitForRestart();
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err));
      setRestoring(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const keepN = Number.parseInt(keep, 10);
    if (!Number.isInteger(keepN) || keepN < 1 || keepN > 365) {
      setError("Keep must be a whole number from 1 to 365.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { settings } = await backupsApi.updateSettings({
        hourUtc: hour === "off" ? null : Number(hour),
        keep: keepN,
      });
      if (res.data) res.setData({ ...res.data, settings });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const backups = res.data?.backups ?? [];
  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Backups</h2>
        <Button variant="primary" size="sm" disabled={running} onClick={() => void backUpNow()}>
          {running ? "Backing up…" : "Back up now"}
        </Button>
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        The database and the data folder (crew, skills, settings; workspaces are left out) in one
        .tar.gz{res.data ? ` in ${res.data.settings.dir}` : ""}. Stored keys stay encrypted, so keep
        SHIPMATE_SECRET (or the .secret file, which is included) safe. Restore puts everything back
        to how it was in a backup.
      </p>
      <ErrorText>{res.error}</ErrorText>
      <ErrorText>{error}</ErrorText>
      {restoring && (
        <p
          role="status"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
        >
          Restoring. Shipmate restarts when it is done, and this page reloads by itself. If it has
          not come back after a few minutes, start the Shipmate container.
        </p>
      )}

      {res.data && (
        <>
          {backups.length === 0 ? (
            <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">No backups yet.</p>
          ) : (
            <ul className="mb-4 divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
              {backups.map((b) => (
                <li
                  key={b.name}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {new Date(b.createdAt).toLocaleString()}
                      <Badge tone={b.trigger === "scheduled" ? "accent" : "neutral"}>
                        {TRIGGER_LABEL[b.trigger] ?? b.trigger}
                      </Badge>
                    </div>
                    <div className="text-xs break-all text-slate-500 dark:text-slate-400">
                      {formatBytes(b.sizeBytes)} · {b.name}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={backupDownloadUrl(b.name)}
                      download={b.name}
                      className="mr-1 text-sm font-medium text-accent-700 hover:underline dark:text-accent-300"
                    >
                      Download
                    </a>
                    <Button size="sm" disabled={restoring !== null} onClick={() => void restore(b)}>
                      Restore
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void remove(b)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Nightly backup"
              value={hour}
              onChange={(e) => setHour(e.target.value)}
            >
              <option value="off">Off</option>
              {HOURS.map((h) => (
                <option key={h} value={String(h)}>
                  {describeHour(h)}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Keep nightly backups"
              hint="Older nightly backups are deleted. Manual and CLI backups stay until you delete them."
              type="number"
              min={1}
              max={365}
              required
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
            />
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save schedule"}
              </Button>
              {saved && (
                <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
              )}
            </div>
          </form>
        </>
      )}
    </Card>
  );
}
