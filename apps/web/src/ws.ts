import type { ClientEvent, ServerEvent } from "@shipmate/core";
import { useEffect, useRef, useSyncExternalStore } from "react";

export type SocketState = "connecting" | "open" | "closed";
type Listener = (event: ServerEvent) => void;

/** Away at least this long, the page reconnects on return rather than trust its old socket. */
const RESUME_RECONNECT_MS = 15_000;

/** One shared WebSocket to /api/ws with reconnect and exponential backoff. */
class ShipSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<() => void>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  state: SocketState = "closed";

  private hiddenAt: number | null = null;

  start() {
    if (this.wanted) return;
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    this.connect();
  }

  stop() {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.setState("closed");
  }

  /**
   * Phones freeze a page in the background (iOS closes its socket without telling it), so a page
   * coming back after a while reconnects at once; the chat then reloads and catches up with the
   * crew, who kept working on the server meanwhile.
   */
  private onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      return;
    }
    const away = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (away >= RESUME_RECONNECT_MS || this.ws?.readyState !== WebSocket.OPEN) this.reconnectNow();
  };

  private onOnline = () => {
    if (this.ws?.readyState !== WebSocket.OPEN) this.reconnectNow();
  };

  private reconnectNow = () => {
    if (!this.wanted) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    const old = this.ws;
    if (old) {
      // Its close event is ignored once it is no longer the current socket.
      this.ws = null;
      old.close();
    }
    this.connect();
  };

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    this.setState("connecting");
    ws.onopen = () => {
      this.attempt = 0;
      this.setState("open");
    };
    ws.onmessage = (msg) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(msg.data)) as ServerEvent;
      } catch {
        return;
      }
      for (const l of this.listeners) l(event);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setState("closed");
      if (!this.wanted) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
      this.attempt++;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.wanted) this.connect();
      }, delay);
    };
  }

  private setState(s: SocketState) {
    this.state = s;
    for (const l of this.stateListeners) l();
  }

  send(event: ClientEvent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(event));
    return true;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribeState(l: () => void): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }
}

export const socket = new ShipSocket();

/** Subscribe to server events; the handler may change every render. */
export function useServerEvents(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => socket.subscribe((e) => ref.current(e)), []);
}

export function useSocketState(): SocketState {
  return useSyncExternalStore(
    (l) => socket.subscribeState(l),
    () => socket.state,
  );
}
