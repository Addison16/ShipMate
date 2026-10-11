import { afterEach, describe, expect, it, vi } from "vitest";
import { type Envelope, SocketAuthError, type SocketLike, SocketModeClient } from "./socket.js";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const l of this.#listeners.get(type) ?? []) l({ data });
  }
  receive(envelope: Envelope) {
    this.emit("message", JSON.stringify(envelope));
  }
  /** Slack (or the network) drops the connection. */
  drop() {
    this.closed = true;
    this.emit("close");
  }
}

function setup(options: { openUrl?: () => Promise<string> } = {}) {
  const sockets: FakeSocket[] = [];
  const envelopes: Envelope[] = [];
  const fatal: string[] = [];
  let n = 0;
  const openUrl = vi.fn(options.openUrl ?? (async () => `wss://slack.test/${++n}`));
  const client = new SocketModeClient({
    openUrl,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onEnvelope: (e) => envelopes.push(e),
    onFatal: (e) => fatal.push(e),
    backoffMs: (attempt) => 1000 * 2 ** attempt,
  });
  return { client, sockets, envelopes, fatal, openUrl };
}

/** Let pending promise callbacks run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
  vi.useRealTimers();
});

describe("SocketModeClient", () => {
  it("connects on hello and acknowledges every envelope before handling it", async () => {
    vi.useFakeTimers();
    const { client, sockets, envelopes } = setup();
    const started = client.start();
    await flush();
    sockets[0]?.receive({ type: "hello" });
    await started;
    expect(client.connected).toBe(true);

    sockets[0]?.receive({ envelope_id: "e1", type: "events_api", payload: { event_id: "Ev1" } });
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ envelope_id: "e1" })]);
    expect(envelopes).toEqual([
      { envelope_id: "e1", type: "events_api", payload: { event_id: "Ev1" } },
    ]);
    sockets[0]?.emit("message", "not json");
    expect(envelopes).toHaveLength(1);
    client.stop();
    expect(sockets[0]?.closed).toBe(true);
  });

  it("moves to a new connection right away when Slack sends disconnect", async () => {
    vi.useFakeTimers();
    const { client, sockets, openUrl } = setup();
    const started = client.start();
    await flush();
    sockets[0]?.receive({ type: "hello" });
    await started;

    sockets[0]?.receive({ type: "disconnect", reason: "refresh_requested" });
    expect(sockets[0]?.closed).toBe(true);
    expect(client.connected).toBe(false);
    await flush();
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(sockets[1]?.url).toBe("wss://slack.test/2");
    sockets[1]?.receive({ type: "hello" });
    expect(client.connected).toBe(true);
    // The old socket's late close does not trigger another reconnect.
    sockets[0]?.emit("close");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("reconnects with growing backoff after drops, and resets once connected", async () => {
    vi.useFakeTimers();
    let fail = false;
    let n = 0;
    const { client, sockets, openUrl } = setup({
      openUrl: async () => {
        n += 1;
        if (fail) throw new Error("network down");
        return `wss://slack.test/${n}`;
      },
    });
    const started = client.start();
    await flush();
    sockets[0]?.receive({ type: "hello" });
    await started;

    fail = true;
    sockets[0]?.drop();
    expect(client.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(openUrl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 1s: first retry fails
    expect(openUrl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(openUrl).toHaveBeenCalledTimes(2);
    fail = false;
    await vi.advanceTimersByTimeAsync(1); // 2s later: second retry works
    expect(openUrl).toHaveBeenCalledTimes(3);
    expect(sockets).toHaveLength(2);
    sockets[1]?.receive({ type: "hello" });
    expect(client.connected).toBe(true);
    expect(client.attempts).toBe(0);

    // A later drop starts from the shortest wait again.
    sockets[1]?.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(3);
    client.stop();
  });

  it("stops for good when the app token is rejected", async () => {
    vi.useFakeTimers();
    let reject = false;
    const { client, sockets, fatal } = setup({
      openUrl: async () => {
        if (reject) throw new SocketAuthError("Slack rejected the app-level token.");
        return "wss://slack.test/x";
      },
    });
    const started = client.start();
    await flush();
    sockets[0]?.receive({ type: "hello" });
    await started;
    reject = true;
    sockets[0]?.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fatal).toEqual(["Slack rejected the app-level token."]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.connected).toBe(false);
  });

  it("rejects start() when the first connection fails, without retrying", async () => {
    vi.useFakeTimers();
    const bad = setup({
      openUrl: async () => {
        throw new SocketAuthError("bad token");
      },
    });
    await expect(bad.client.start()).rejects.toThrow("bad token");

    const closed = setup();
    const started = closed.client.start();
    await flush();
    closed.sockets[0]?.drop();
    await expect(started).rejects.toThrow(/before it was ready/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closed.sockets).toHaveLength(1);
  });

  it("does nothing after stop()", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const started = client.start();
    await flush();
    sockets[0]?.receive({ type: "hello" });
    await started;
    client.stop();
    sockets[0]?.emit("close");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});
