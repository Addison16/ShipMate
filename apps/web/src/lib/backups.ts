import type { BackupDto, BackupSettingsDto } from "@shipmate/core";
import { request } from "../api.js";

export type BackupSettingsUpdate = Partial<{ hourUtc: number | null; keep: number }>;

const enc = encodeURIComponent;

export const backupsApi = {
  list: () => request<{ backups: BackupDto[]; settings: BackupSettingsDto }>("GET", "/api/backups"),
  create: () => request<{ backup: BackupDto }>("POST", "/api/backups"),
  remove: (name: string) => request<{ ok: true }>("DELETE", `/api/backups/${enc(name)}`),
  updateSettings: (body: BackupSettingsUpdate) =>
    request<{ settings: BackupSettingsDto }>("PUT", "/api/backups/settings", body),
};

/** Where the browser downloads a backup (a plain link; the session cookie authorizes it). */
export function backupDownloadUrl(name: string): string {
  return `/api/backups/${enc(name)}`;
}

/** 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export const TRIGGER_LABEL: Record<string, string> = {
  manual: "Manual",
  scheduled: "Nightly",
  cli: "CLI",
};

/** "03:00 UTC (05:00 your time)" for an hour 0-23. */
export function describeHour(hourUtc: number, now = new Date()): string {
  const utc = `${String(hourUtc).padStart(2, "0")}:00 UTC`;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  const local = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.getTimezoneOffset() === 0 ? utc : `${utc} (${local} your time)`;
}
