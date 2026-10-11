import type { PushDeviceDto, PushEvents } from "@shipmate/core";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { formatTime } from "../lib/format.js";
import {
  base64UrlToBytes,
  currentPushSupport,
  deviceLabel,
  PUSH_EVENTS,
  pushApi,
} from "../lib/push.js";
import { useResource } from "../lib/useResource.js";
import { Badge, Button, Card, ErrorText, Muted, Notice } from "./ui.js";

/** The service worker, or null when none is registered (dev builds, blocked browsers). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/** Settings → Notifications: push on this device, what to get, other devices, a test. */
export function PushSettings() {
  const support = currentPushSupport();
  const status = useResource(() => pushApi.status());
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<string | null>(null);

  const findEndpoint = useCallback(async () => {
    if (support !== "ok") return;
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    setEndpoint(sub?.endpoint ?? null);
  }, [support]);

  useEffect(() => {
    void findEndpoint();
  }, [findEndpoint]);

  const devices = status.data?.devices ?? [];
  const here = devices.find((d) => d.endpoint === endpoint) ?? null;
  const others = devices.filter((d) => d !== here);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError(
          "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.",
        );
        return;
      }
      const reg = await registration();
      if (!reg || !status.data) {
        setError("The app's service worker is not running here. Open the installed app or reload.");
        return;
      }
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(status.data.publicKey),
        }));
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error("The browser returned an incomplete subscription.");
      }
      await pushApi.subscribe({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints),
      });
      setEndpoint(json.endpoint);
      await status.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(device: PushDeviceDto) {
    setError(null);
    try {
      if (device === here) {
        const sub = await (await registration())?.pushManager.getSubscription();
        await sub?.unsubscribe();
        setEndpoint(null);
      }
      await pushApi.remove(device.id);
      await status.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggle(device: PushDeviceDto, key: keyof PushEvents, on: boolean) {
    setError(null);
    try {
      const { device: updated } = await pushApi.update(device.id, { [key]: on });
      if (status.data) {
        status.setData({
          ...status.data,
          devices: status.data.devices.map((d) => (d.id === updated.id ? updated : d)),
        });
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function test() {
    setError(null);
    setTested(null);
    try {
      const r = await pushApi.test();
      setTested(
        r.sent
          ? `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"}.${r.removed ? ` Removed ${r.removed} that no longer accept notifications.` : ""}`
          : "No device accepted it. Turn notifications on again on the device.",
      );
      await status.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Notifications</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Get a ping on your phone or desktop when the crew needs you, even with Shipmate closed.
      </p>
      <ErrorText>{status.error}</ErrorText>

      {support === "ios-install" && (
        <Notice>
          On iPhone and iPad, notifications only work in the installed app: tap Share, then{" "}
          <strong>Add to Home Screen</strong>, and open Shipmate from there to turn them on. Approve
          and Deny buttons are not shown on iOS; tapping the notification opens the request.
        </Notice>
      )}
      {support === "insecure" && (
        <Notice>
          Notifications need Shipmate served over HTTPS (or opened on localhost). Set SHIPMATE_URL
          to an https address behind a reverse proxy.
        </Notice>
      )}
      {support === "unsupported" && <Notice>This browser does not support notifications.</Notice>}

      {support === "ok" && (
        <div className="space-y-3">
          {here ? (
            <DeviceRow device={here} current onToggle={toggle} onRemove={remove} />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={busy || !status.data}
                onClick={() => void enable()}
              >
                {busy ? "Turning on…" : "Turn on for this device"}
              </Button>
              <Muted>The browser asks for permission first.</Muted>
            </div>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-5 space-y-3">
          <h3 className="text-sm font-medium">Your other devices</h3>
          {others.map((d) => (
            <DeviceRow key={d.id} device={d} onToggle={toggle} onRemove={remove} />
          ))}
        </div>
      )}

      <ErrorText>{error}</ErrorText>
      {devices.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void test()}>Send a test</Button>
          {tested && <span className="text-sm text-slate-600 dark:text-slate-300">{tested}</span>}
        </div>
      )}
    </Card>
  );
}

function DeviceRow({
  device,
  current,
  onToggle,
  onRemove,
}: {
  device: PushDeviceDto;
  current?: boolean;
  onToggle: (d: PushDeviceDto, key: keyof PushEvents, on: boolean) => Promise<void>;
  onRemove: (d: PushDeviceDto) => Promise<void>;
}) {
  return (
    <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium">{device.label}</span>
        {current && <Badge tone="ok">this device</Badge>}
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {device.lastSentAt
            ? `last notified ${formatTime(device.lastSentAt)}`
            : "nothing sent yet"}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void onRemove(device)}>
          {current ? "Turn off" : "Remove"}
        </Button>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Notifications for {device.label}</legend>
        {PUSH_EVENTS.map((e) => (
          <label key={e.key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-accent-700"
              checked={device.events[e.key]}
              onChange={(ev) => void onToggle(device, e.key, ev.target.checked)}
            />
            <span>
              {e.label}
              <span className="block text-xs text-slate-500 dark:text-slate-400">{e.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
