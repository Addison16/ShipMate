import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { users } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePushService } from "./push/fake.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("push notifications", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  const push = new FakePushService();
  let ownerCookie = "";
  let memberCookie = "";
  let ownerId = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    cookie = ownerCookie,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: cookie ? { cookie } : {},
    });
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    t = await testApp(db as string, { pushFetch: push.fetch });
    const setup = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
      "",
    );
    ownerCookie = cookieOf(setup);
    ownerId = setup.json().user.id;
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("hands out one VAPID key and subscribes devices from known push services", async () => {
    const a = (await api("GET", "/api/push")).json();
    const b = (await api("GET", "/api/push", undefined, memberCookie)).json();
    expect(a.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(b.publicKey).toBe(a.publicKey);
    expect(a.devices).toEqual([]);

    const evil = push.subscription("169.254.169.254");
    const refused = await api("POST", "/api/push/devices", { ...evil, label: "x" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/SHIPMATE_PUSH_HOSTS/);

    const phone = push.subscription();
    const res = await api("POST", "/api/push/devices", { ...phone, label: "Pixel, Chrome" });
    expect(res.statusCode).toBe(200);
    expect(res.json().device).toMatchObject({
      label: "Pixel, Chrome",
      events: { approvals: true, watches: true, messages: true },
    });
    // Subscribing the same browser again updates the row instead of adding one.
    await api("POST", "/api/push/devices", { ...phone, label: "Pixel 9" });
    const devices = (await api("GET", "/api/push")).json().devices;
    expect(devices).toHaveLength(1);
    expect(devices[0].label).toBe("Pixel 9");
    // Nobody else can see, change or remove it.
    expect((await api("GET", "/api/push", undefined, memberCookie)).json().devices).toEqual([]);
    expect(
      (await api("DELETE", `/api/push/devices/${devices[0].id}`, undefined, memberCookie))
        .statusCode,
    ).toBe(404);
  });

  it("sends a test and prunes subscriptions the push service says are gone", async () => {
    const old = push.subscription();
    await api("POST", "/api/push/devices", { ...old, label: "Old laptop" });
    push.status.set(old.endpoint, 410);
    push.received.length = 0;
    const res = (await api("POST", "/api/push/test")).json();
    expect(res).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(push.received[0]?.payload).toMatchObject({ kind: "test", title: "Shipmate" });
    expect(push.received[0]?.headers.authorization).toMatch(/^vapid t=.+, k=B/);
    const labels = (await api("GET", "/api/push"))
      .json()
      .devices.map((d: { label: string }) => d.label);
    expect(labels).toEqual(["Pixel 9"]);
  });

  it("lets a notification approve or deny once, with its own token and no cookie", async () => {
    const [device] = (await api("GET", "/api/push")).json().devices;
    push.received.length = 0;
    const answer = t.app.services.approvals.request({
      userId: ownerId,
      conversationId: null,
      watchId: null,
      crew: { slug: "captain", name: "Captain" },
      toolName: "bash",
      args: { command: "ls" },
    });
    await until(() => push.received.length > 0);
    const note = push.for(device.endpoint)[0];
    expect(note).toMatchObject({ kind: "approval", title: "Captain needs your OK" });
    expect(push.received[0]?.headers.urgency).toBe("high");
    const id = note?.approval?.id as string;
    const token = note?.approval?.token as string;

    const act = (body: unknown, approvalId = id) =>
      t.app.inject({
        method: "POST",
        url: `/api/push/act/approvals/${approvalId}`,
        payload: body as object,
      });
    // A forged or misdirected token does nothing.
    expect(
      (await act({ token: `${token.split(".")[0]}.${"A".repeat(43)}`, decision: "allow" }))
        .statusCode,
    ).toBe(410);
    expect(
      (await act({ token, decision: "allow" }, "00000000-0000-0000-0000-000000000000")).statusCode,
    ).toBe(410);
    expect((await act({ token, decision: "always" })).statusCode).toBe(400);

    expect((await act({ token, decision: "deny" })).statusCode).toBe(200);
    expect(await answer).toBe("deny");
    // The token is spent.
    expect((await act({ token, decision: "allow" })).statusCode).toBe(410);
  });

  it("rejects expired tokens", async () => {
    const answer = t.app.services.approvals.request({
      userId: ownerId,
      conversationId: null,
      watchId: null,
      crew: { slug: "captain", name: "Captain" },
      toolName: "bash",
      args: {},
    });
    const [pending] = t.app.services.approvals.list(ownerId);
    const id = pending?.id as string;
    const stale = t.app.services.push.approvalToken(ownerId, id, Date.now() - 1000);
    const res = await t.app.inject({
      method: "POST",
      url: `/api/push/act/approvals/${id}`,
      payload: { token: stale, decision: "allow" },
    });
    expect(res.statusCode).toBe(410);
    // A token for someone else's approval is refused too.
    const other = t.app.services.push.approvalToken("someone-else", id, Date.now() + 60_000);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/api/push/act/approvals/${id}`,
          payload: { token: other, decision: "allow" },
        })
      ).statusCode,
    ).toBe(410);
    t.app.services.approvals.decide(ownerId, id, "deny");
    expect(await answer).toBe("deny");
  });

  it("pushes crew replies only while no tab is open, and respects each device's choices", async () => {
    const [device] = (await api("GET", "/api/push")).json().devices;
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const send = async (text: string) => {
      t.faux.setResponses([fauxAssistantMessage(`Reply to ${text}`)]);
      const [owner] = await t.app.db.select().from(users).where(eq(users.id, ownerId));
      if (!owner) throw new Error("no owner");
      await t.app.services.bridge.send(owner, conv.id, text);
    };

    // With a tab open: nothing pushed.
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    push.received.length = 0;
    await send("one");
    await new Promise((r) => setTimeout(r, 100));
    expect(push.received).toEqual([]);
    ws.terminate();
    await new Promise((r) => setTimeout(r, 100));

    // No tab: the reply arrives as a notification that opens the conversation.
    await send("two");
    await until(() => push.received.length > 0);
    expect(push.for(device.endpoint)[0]).toMatchObject({
      kind: "message",
      title: "Captain",
      body: "Reply to two",
      url: `/#/bridge/${conv.id}`,
    });

    // This device opted out of crew replies.
    const patched = await api("PATCH", `/api/push/devices/${device.id}`, {
      events: { messages: false },
    });
    expect(patched.json().device.events).toEqual({
      approvals: true,
      watches: true,
      messages: false,
    });
    push.received.length = 0;
    await send("three");
    await new Promise((r) => setTimeout(r, 100));
    expect(push.received).toEqual([]);

    expect((await api("DELETE", `/api/push/devices/${device.id}`)).json()).toEqual({ ok: true });
    expect((await api("GET", "/api/push")).json().devices).toEqual([]);
  });
});
