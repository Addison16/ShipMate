import type {
  PushDeviceDto,
  PushEvents,
  PushStatusDto,
  SubscribePushRequest,
} from "@shipmate/core";
import { request } from "../api.js";

const enc = encodeURIComponent;

export const pushApi = {
  status: () => request<PushStatusDto>("GET", "/api/push"),
  subscribe: (body: SubscribePushRequest) =>
    request<{ device: PushDeviceDto }>("POST", "/api/push/devices", body),
  update: (id: string, events: Partial<PushEvents>) =>
    request<{ device: PushDeviceDto }>("PATCH", `/api/push/devices/${enc(id)}`, { events }),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/push/devices/${enc(id)}`),
  test: () => request<{ sent: number; failed: number; removed: number }>("POST", "/api/push/test"),
};

export const PUSH_EVENTS: Array<{ key: keyof PushEvents; label: string; hint: string }> = [
  {
    key: "approvals",
    label: "Approval requests",
    hint: "A crew member waits for your OK. Approve or Deny right from the notification.",
  },
  { key: "watches", label: "Watch results", hint: "One of your watches finished or failed." },
  {
    key: "messages",
    label: "Crew replies",
    hint: "A reply on the Bridge while you have no Shipmate tab open.",
  },
];

/** The VAPID key as PushManager.subscribe wants it. */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** iPhone, iPad (which reports itself as a Mac with a touch screen) or iPod. */
export function isIos(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** A name to tell devices apart in the list, e.g. "iPhone, Safari" or "Windows, Edge". */
export function deviceLabel(ua: string, maxTouchPoints = 0): string {
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPod/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
        ? "iPad"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "browser";
  return `${os}, ${browser}`;
}

export type PushSupport =
  | "ok"
  /** Served over plain http from somewhere other than localhost. */
  | "insecure"
  /** iOS only allows Web Push for apps added to the Home Screen. */
  | "ios-install"
  | "unsupported";

export function pushSupport(env: {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  ios: boolean;
  standalone: boolean;
}): PushSupport {
  if (!env.secure) return "insecure";
  if (env.ios && !env.standalone) return "ios-install";
  if (!env.serviceWorker || !env.pushManager || !env.notification) return "unsupported";
  return "ok";
}

/** This browser's environment, for pushSupport. */
export function currentPushSupport(): PushSupport {
  const nav = navigator as Navigator & { standalone?: boolean };
  return pushSupport({
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    ios: isIos(navigator.userAgent, navigator.maxTouchPoints),
    standalone:
      nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true,
  });
}
