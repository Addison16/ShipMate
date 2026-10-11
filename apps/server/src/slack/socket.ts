/**
 * A Slack Socket Mode connection: ask apps.connections.open for a WebSocket URL, acknowledge
 * every envelope right away, and reconnect when Slack asks to (a "disconnect" envelope, which
 * it sends every few hours) or the socket drops, backing off on repeated failures. Only a
 * rejected app token stops it for good.
 */

/** The bits of a WebSocket this client uses (Node 22's global WebSocket fits). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface Envelope {
  envelope_id?: string;
  type: string;
  payload?: unknown;
  reason?: string;
  retry_attempt?: number;
}

/** apps.connections.open failed because of the token: retrying will not help. */
export class SocketAuthError extends Error {}

export interface SocketModeOptions {
  /** apps.connections.open; throws SocketAuthError for a bad token. */
  openUrl: () => Promise<string>;
  createSocket?: (url: string) => SocketLike;
  /** Each envelope that carries something (after it has been acknowledged). */
  onEnvelope: (envelope: Envelope) => void;
  /** Reconnecting has stopped for good. */
  onFatal: (error: string) => void;
  /** Wait before the n-th reconnect in a row (n from 0). */
  backoffMs?: (attempt: number) => number;
  /** Give up on a first connection that has not said hello by then. */
  helloTimeoutMs?: number;
}

export const defaultBackoff = (attempt: number) =>
  Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 500);

export class SocketModeClient {
  connected = false;
  /** Reconnects since the last good connection (tests). */
  attempts = 0;
  #socket: SocketLike | null = null;
  #stopped = true;
  #timer: NodeJS.Timeout | null = null;
  readonly #create: (url: string) => SocketLike;
  readonly #backoff: (attempt: number) => number;

  constructor(private readonly options: SocketModeOptions) {
    this.#create = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.#backoff = options.backoffMs ?? defaultBackoff;
  }

  /**
   * Connect and wait for Slack's hello. Rejects when the first attempt fails; after that,
   * drops are retried in the background.
   */
  start(): Promise<void> {
    this.#stopped = false;
    this.attempts = 0;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => fail(new Error("Slack did not open the Socket Mode connection in time.")),
        this.options.helloTimeoutMs ?? 15_000,
      );
      timeout.unref?.();
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.stop();
        reject(err);
      };
      this.#open({
        hello: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        },
        fail,
      }).catch(fail);
    });
  }

  stop() {
    this.#stopped = true;
    this.connected = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close(1000, "stopping");
    } catch {
      // Already closed.
    }
  }

  /** Open a socket. `first` is set for the start() attempt, whose failure is reported. */
  async #open(first?: { hello: () => void; fail: (err: unknown) => void }) {
    const url = await this.options.openUrl();
    if (this.#stopped) return;
    const socket = this.#create(url);
    this.#socket = socket;
    let said = false;

    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(event.data)) as Envelope;
      } catch {
        return;
      }
      if (envelope.envelope_id) {
        try {
          socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        } catch {
          // The close handler reconnects.
        }
      }
      if (envelope.type === "hello") {
        said = true;
        this.connected = true;
        this.attempts = 0;
        first?.hello();
        return;
      }
      if (envelope.type === "disconnect") {
        // Slack is about to close this connection; move to a new one right away.
        this.#replace(socket, 0);
        return;
      }
      if (envelope.payload !== undefined) this.options.onEnvelope(envelope);
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket || this.#stopped) return;
      if (first && !said) {
        first.fail(new Error("Slack closed the Socket Mode connection before it was ready."));
        return;
      }
      this.#replace(socket, null);
    });
    socket.addEventListener("error", () => {
      // A close event follows.
    });
  }

  /** Drop `old` and connect again, after `delay` ms (null: back off). */
  #replace(old: SocketLike, delay: number | null) {
    if (this.#socket !== old || this.#stopped) return;
    this.#socket = null;
    this.connected = false;
    try {
      old.close(1000, "reconnecting");
    } catch {
      // Already closed.
    }
    this.#schedule(delay);
  }

  #schedule(delay: number | null) {
    if (this.#stopped) return;
    const wait = delay ?? this.#backoff(this.attempts);
    this.attempts += 1;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#open().catch((err) => {
        if (this.#stopped) return;
        if (err instanceof SocketAuthError) {
          this.stop();
          this.options.onFatal(err.message);
          return;
        }
        this.#schedule(null);
      });
    }, wait);
    this.#timer.unref?.();
  }
}
