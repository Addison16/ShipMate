import type { SessionDto } from "@shipmate/core";
import { useState } from "react";
import { api, errorMessage } from "../api.js";
import { deviceLabel } from "../lib/devices.js";
import { formatTime } from "../lib/format.js";
import { useResource } from "../lib/useResource.js";
import { Button, Card, ErrorText, Loading } from "./ui.js";

/** Where this person is signed in, with a way to sign any of those devices out. */
export function DeviceSettings() {
  const devices = useResource(() => api.listSessions(), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sessions = devices.data?.sessions ?? [];
  const others = sessions.filter((s) => !s.current);

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await devices.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Signed-in devices</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Sign out any device you don't know. Changing your password signs out all the others.
      </p>
      <ErrorText>{devices.error ?? error}</ErrorText>
      {devices.loading && !devices.data && <Loading />}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {sessions.map((s: SessionDto) => (
          <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {deviceLabel(s.userAgent)}
                {s.current && (
                  <span className="ml-2 rounded-full bg-accent-100 px-2 py-0.5 text-xs font-medium text-accent-900 dark:bg-accent-500/20 dark:text-accent-100">
                    This device
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {s.current ? "In use now" : `Last used ${formatTime(s.lastSeenAt)}`} · signed in{" "}
                {formatTime(s.createdAt)}
              </p>
            </div>
            {!s.current && (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void run(s.id, () => api.endSession(s.id))}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 1 && (
        <div className="mt-3">
          <Button
            variant="danger"
            disabled={busy !== null}
            onClick={() => void run("others", () => api.endOtherSessions())}
          >
            Sign out all other devices
          </Button>
        </div>
      )}
    </Card>
  );
}
