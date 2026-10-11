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
import { Badge, Button, Card, ErrorText, SelectField, Table, TextField, td, th } from "./ui.js";

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
        SHIPMATE_SECRET (or the .secret file, which is included) safe. Restore with{" "}
        <code className="text-xs">shipmate restore &lt;file&gt; --yes</code> while the server is
        stopped.
      </p>
      <ErrorText>{res.error}</ErrorText>
      <ErrorText>{error}</ErrorText>

      {res.data && (
        <>
          {backups.length === 0 ? (
            <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">No backups yet.</p>
          ) : (
            <div className="mb-4">
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Backup</th>
                    <th className={th}>Size</th>
                    <th className={th}>Kind</th>
                    <th className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.name}>
                      <td className={td}>
                        <div className="font-medium">{new Date(b.createdAt).toLocaleString()}</div>
                        <div className="text-xs break-all text-slate-500 dark:text-slate-400">
                          {b.name}
                        </div>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>{formatBytes(b.sizeBytes)}</td>
                      <td className={td}>
                        <Badge tone={b.trigger === "scheduled" ? "accent" : "neutral"}>
                          {TRIGGER_LABEL[b.trigger] ?? b.trigger}
                        </Badge>
                      </td>
                      <td className={`${td} text-right whitespace-nowrap`}>
                        <a
                          href={backupDownloadUrl(b.name)}
                          download={b.name}
                          className="mr-2 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                        >
                          Download
                        </a>
                        <Button size="sm" variant="danger" onClick={() => void remove(b)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
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
