import type { ApprovalDecision, MessageDto, ServerEvent } from "@shipmate/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDiscordPort } from "./fake.js";
import { DISCORD_FILE_LIMIT } from "./port.js";
import { DiscordRelay, type RelayLookup, TYPING_REFRESH_MS } from "./relay.js";

const PERSON = "100000000000000001";
const STRANGER = "100000000000000002";

function setup(options: { webhook?: boolean; files?: Map<string, Buffer> } = {}) {
  const port = new FakeDiscordPort();
  const channelId = port.addChannel("captain");
  const webhook = { id: "w1", token: "t1" };
  port.webhooks.set("w1", { ...webhook, channelId });
  const lookup: RelayLookup = {
    target: async (id) => (id === "conv-d" ? { channelId, discordUserId: PERSON } : null),
    webhook: async () => (options.webhook === false ? null : webhook),
    userByDiscordId: async (id) => (id === PERSON ? { id: "u1" } : null),
    userName: async () => "Addison",
    readFile: async (_userId, id) => {
      const data = options.files?.get(id);
      if (!data) throw new Error("file not found");
      return data;
    },
  };
  const decided: { userId: string; id: string; decision: ApprovalDecision }[] = [];
  const relay = new DiscordRelay(port, lookup, {
    decide: (userId, id, decision) => {
      decided.push({ userId, id, decision });
      relay.handle(userId, { type: "approval_resolved", approvalId: id, decision });
    },
  });
  port.listen((event) => {
    if (event.type === "button") void relay.button(event);
  });
  return { port, relay, channelId, decided };
}

const crewMessage = (conversationId: string, content: string, name = "Captain"): ServerEvent => ({
  type: "message",
  conversationId,
  message: {
    id: "m1",
    conversationId,
    role: "assistant",
    content,
    author: { kind: "crew", slug: name.toLowerCase(), name },
    meta: null,
    createdAt: new Date().toISOString(),
  } satisfies MessageDto,
});

const approval = (id: string): ServerEvent => ({
  type: "approval_request",
  approval: {
    id,
    conversationId: "conv-d",
    routineId: null,
    crew: { slug: "galley", name: "Galley" },
    toolName: "bash",
    summary: "Galley wants to run bash: ls",
    detail: '{\n  "command": "ls"\n}',
    createdAt: new Date().toISOString(),
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DiscordRelay", () => {
  it("posts crew replies through the webhook under the speaker's name, mentioning the person once", async () => {
    const { port, relay, channelId } = setup();
    const long = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`;
    relay.handle("u1", crewMessage("conv-d", long, "Galley"));
    await relay.idle();
    expect(port.webhookPosts).toHaveLength(2);
    expect(port.webhookPosts[0]).toMatchObject({
      channelId,
      username: "Galley",
      mentionUserIds: [PERSON],
    });
    expect(port.webhookPosts[0]?.content.startsWith(`<@${PERSON}> a`)).toBe(true);
    expect(port.webhookPosts[1]).toMatchObject({ mentionUserIds: [] });
    expect(port.webhookPosts[1]?.content).toBe("b".repeat(1500));
  });

  it("ignores web conversations, the person's own echo and streaming noise", async () => {
    const { port, relay } = setup();
    relay.handle("u1", crewMessage("conv-web", "hello"));
    relay.handle("u1", {
      type: "message",
      conversationId: "conv-d",
      message: {
        id: "m0",
        conversationId: "conv-d",
        role: "user",
        content: "hi",
        author: { kind: "user", id: "u1", name: "Addison" },
        meta: null,
        createdAt: "",
      },
    });
    relay.handle("u1", { type: "delta", conversationId: "conv-d", streamId: "s", text: "x" });
    await relay.idle();
    expect(port.webhookPosts).toEqual([]);
    expect(port.botMessages).toEqual([]);
  });

  it("falls back to a labelled bot message when the channel has no webhook", async () => {
    const { port, relay } = setup({ webhook: false });
    relay.handle("u1", crewMessage("conv-d", "Aye"));
    await relay.idle();
    expect(port.botMessages[0]?.content).toBe(`<@${PERSON}> **Captain:** Aye`);
  });

  it("posts only the readable pictures of a picture-only reply, at most eight", async () => {
    const files = new Map<string, Buffer>([["big", Buffer.alloc(DISCORD_FILE_LIMIT + 1)]]);
    const list = [{ id: "big", name: "big.png", kind: "image", mimeType: "image/png", size: 1 }];
    list.push({ id: "gone", name: "gone.png", kind: "image", mimeType: "image/png", size: 1 });
    for (let i = 0; i < 9; i++) {
      files.set(`p${i}`, Buffer.from([i]));
      list.push({ id: `p${i}`, name: `p${i}.png`, kind: "image", mimeType: "image/png", size: 1 });
    }
    const { port, relay } = setup({ webhook: false, files });
    const event = crewMessage("conv-d", " ");
    if (event.type === "message") event.message.meta = { attachments: list };
    relay.handle("u1", event);
    await relay.idle();
    expect(port.botMessages).toHaveLength(1);
    expect(port.botMessages[0]).toMatchObject({
      content: `<@${PERSON}> **Captain:**`,
      mentionUserIds: [PERSON],
    });
    // The first eight are taken; the too-big and missing ones are skipped.
    expect(port.botMessages[0]?.files?.map((f) => f.name)).toEqual([
      "p0.png",
      "p1.png",
      "p2.png",
      "p3.png",
      "p4.png",
      "p5.png",
    ]);
  });

  it("posts hand-offs and errors, in order", async () => {
    const { port, relay } = setup();
    relay.handle("u1", {
      type: "handoff",
      conversationId: "conv-d",
      from: { slug: "captain", name: "Captain" },
      to: { slug: "galley", name: "Galley" },
      task: "plan\ndinner",
    });
    relay.handle("u1", crewMessage("conv-d", "Pasta.", "Galley"));
    relay.handle("u1", { type: "error", conversationId: "conv-d", message: "model failed" });
    await relay.idle();
    expect(port.webhookPosts.map((p) => [p.username, p.content])).toEqual([
      ["Captain", "_Captain asked Galley: plan dinner_"],
      ["Galley", `<@${PERSON}> Pasta.`],
    ]);
    expect(port.botMessages[0]?.content).toBe("⚠️ model failed");
  });

  it("shows typing while busy and stops when done", async () => {
    vi.useFakeTimers();
    const { port, relay, channelId } = setup();
    relay.handle("u1", { type: "status", conversationId: "conv-d", busy: true });
    await relay.idle();
    expect(port.typingCalls).toEqual([channelId]);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
    expect(port.typingCalls).toHaveLength(3);
    relay.handle("u1", { type: "status", conversationId: "conv-d", busy: false });
    await relay.idle();
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
    expect(port.typingCalls).toHaveLength(3);
  });

  it("posts approval cards that only the requesting person can answer", async () => {
    const { port, relay, decided } = setup();
    relay.handle("u1", approval("a1"));
    await relay.idle();
    const card = port.botMessages[0];
    expect(card?.content).toContain(`<@${PERSON}> **Galley wants to run bash: ls**`);
    expect(card?.content).toContain('"command": "ls"');
    expect(card?.buttons?.map((b) => b.label)).toEqual([
      "Allow once",
      "Always allow for Galley",
      "Deny",
    ]);
    const allow = card?.buttons?.[0]?.customId ?? "";

    expect(await port.click(STRANGER, card?.id ?? "", allow)).toBe("Only Addison can answer this.");
    expect(decided).toEqual([]);

    expect(await port.click(PERSON, card?.id ?? "", allow)).toBe("acknowledged");
    expect(decided).toEqual([{ userId: "u1", id: "a1", decision: "allow" }]);
    await relay.idle();
    expect(port.edits[0]).toMatchObject({ messageId: card?.id, buttons: [] });
    expect(port.edits[0]?.content).toContain("Addison allowed it once");

    expect(await port.click(PERSON, card?.id ?? "", allow)).toBe(
      "This request is no longer waiting for an answer.",
    );
  });

  it("takes a typed approve or deny from the person who was asked", async () => {
    const { relay, channelId, decided, port } = setup();
    relay.handle("u1", approval("a3"));
    relay.handle("u1", approval("a4"));
    await relay.idle();
    expect(relay.answer("other-channel", "u1", "approve")).toEqual({ handled: false });
    expect(relay.answer(channelId, "u1", "what is this?")).toEqual({ handled: false });
    // Someone else in the channel saying "yes" is talking to their own crew conversation.
    expect(relay.answer(channelId, "u2", "yes")).toEqual({ handled: false });
    expect(decided).toEqual([]);
    // The newest card is answered first.
    expect(relay.answer(channelId, "u1", "Deny.")).toEqual({ handled: true, reply: null });
    expect(decided).toEqual([{ userId: "u1", id: "a4", decision: "deny" }]);
    await relay.idle();
    expect(port.edits.at(-1)?.content).toContain("Addison denied it");
    expect(relay.answer(channelId, "u1", "approve")).toEqual({ handled: true, reply: null });
    expect(decided.at(-1)).toEqual({ userId: "u1", id: "a3", decision: "allow" });
    await relay.idle();
    expect(relay.answer(channelId, "u1", "approve")).toEqual({ handled: false });
  });

  it("marks a card expired when nobody answers", async () => {
    const { port, relay } = setup();
    relay.handle("u1", approval("a2"));
    relay.handle("u1", { type: "approval_resolved", approvalId: "a2", decision: "expired" });
    await relay.idle();
    expect(port.edits[0]?.content).toContain("Nobody answered in time");
  });
});
