import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("crew keep working when the page closes", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const api = (method: "GET" | "POST" | "PUT", url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  beforeAll(async () => {
    t = await testApp(db as string);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "o@example.com", displayName: "Addison", password: "correct horse" },
    });
    cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  const connect = async () => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    const next = async <K extends ServerEvent["type"]>(type: K) => {
      for (let i = 0; i < 200; i++) {
        const e = events.find((x) => x.type === type);
        if (e) return e as Extract<ServerEvent, { type: K }>;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no ${type} event`);
    };
    return { ws, events, next };
  };

  it("keeps a turn going after the page closes, and a page that comes back catches up", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxText("Checking the pantry."),
        fauxToolCall("remember", { name: "diet", description: "vegetarian", body: "No meat." }),
      ]),
      async () => {
        await gate;
        return fauxAssistantMessage("Lentil curry on Tuesday.");
      },
    ]);

    const first = await connect();
    first.ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "Dinner?" }));
    await first.next("stream_start");
    // The phone closes the page while the Captain is still working.
    first.ws.terminate();
    for (let i = 0; i < 200 && t.faux.getPendingResponseCount() > 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Opened again mid-turn: the reply so far and its tool show, and the crew are still busy.
    const second = await connect();
    second.ws.send(JSON.stringify({ type: "watch", conversationId: conv.id }));
    const live = await second.next("live");
    expect(live.busy).toBe(true);
    expect(live.items).toHaveLength(1);
    expect(live.items[0]).toMatchObject({
      kind: "stream",
      crew: { name: "Captain" },
      text: expect.stringContaining("Checking the pantry."),
      tools: [{ name: "remember", running: false }],
    });

    // The turn finishes while it is open, and the full reply is saved either way.
    release();
    await second.next("message");
    for (let i = 0; i < 200; i++) {
      if (second.events.some((e) => e.type === "status" && !e.busy)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    second.ws.terminate();
    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(messages.map((m: { content: string }) => m.content)).toEqual([
      "Dinner?",
      "Checking the pantry.\n\nLentil curry on Tuesday.",
    ]);

    // Nothing is left running, so a later page sees an idle chat.
    const third = await connect();
    third.ws.send(JSON.stringify({ type: "watch", conversationId: conv.id }));
    expect(await third.next("live")).toMatchObject({ busy: false, items: [] });
    third.ws.terminate();
  });
});
