import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { batches, isChatsFile, parseExport, readExportFile } from "./chat-import.js";

const node = (
  id: string,
  parent: string | null,
  role: string,
  parts: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  id,
  parent,
  children: [],
  message: {
    author: { role },
    create_time: 1_710_000_000 + Number(id.replace(/\D/g, "") || 0),
    content: { content_type: "text", parts },
    recipient: "all",
    ...extra,
  },
});

const chatGpt = [
  {
    conversation_id: "c-1",
    title: "Boiling eggs",
    create_time: 1_710_000_000,
    update_time: 1_710_000_500,
    current_node: "n5",
    mapping: {
      root: { id: "root", parent: null, children: ["n0"], message: null },
      n0: node("n0", "root", "system", ["You are ChatGPT"]),
      n1: node("n1", "n0", "user", ["How long do I boil an egg?"]),
      // A first answer the person regenerated: not on the path from current_node.
      n2: node("n2", "n1", "assistant", ["Ten minutes."]),
      n3: node("n3", "n1", "assistant", ["search(eggs)"], { recipient: "browser" }),
      n4: node("n4", "n3", "tool", ["results"]),
      n5: node("n5", "n4", "assistant", ["Seven minutes for a jammy yolk."]),
    },
  },
  {
    id: "c-2",
    title: "",
    create_time: 1_700_000_000,
    mapping: {
      a1: {
        id: "a1",
        parent: null,
        children: [],
        message: {
          author: { role: "user" },
          create_time: 1_700_000_001,
          content: {
            content_type: "multimodal_text",
            parts: [{ asset_pointer: "file-service://x" }, "What is this plant?"],
          },
        },
      },
    },
  },
  { conversation_id: "c-3", title: "Empty", mapping: {} },
];

const claude = [
  {
    uuid: "u-1",
    name: "Trip plan",
    created_at: "2025-01-05T09:00:00.000Z",
    updated_at: "2025-01-05T09:10:00.000Z",
    chat_messages: [
      { sender: "human", text: "Plan a day in Lisbon", created_at: "2025-01-05T09:00:00.000Z" },
      {
        sender: "assistant",
        text: "old flat text",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Start in Alfama." },
        ],
        created_at: "2025-01-05T09:00:20.000Z",
      },
      { sender: "human", text: "", created_at: "2025-01-05T09:01:00.000Z" },
    ],
  },
];

describe("parseExport", () => {
  it("reads a ChatGPT export along the path last shown", () => {
    const { source, chats } = parseExport(chatGpt);
    expect(source).toBe("chatgpt");
    expect(chats.map((c) => c.externalId)).toEqual(["c-1", "c-2"]);
    expect(chats[0]?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "How long do I boil an egg?"],
      ["assistant", "Seven minutes for a jammy yolk."],
    ]);
    expect(chats[0]?.createdAt).toBe(new Date(1_710_000_000_000).toISOString());
    expect(chats[0]?.updatedAt).toBe(new Date(1_710_000_500_000).toISOString());
    // No current_node, no title, and a picture.
    expect(chats[1]).toMatchObject({
      title: "Untitled chat",
      messages: [{ role: "user", text: "[picture or file]\n\nWhat is this plant?" }],
    });
  });

  it("reads a Claude export", () => {
    const { source, chats } = parseExport(claude);
    expect(source).toBe("claude");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ externalId: "u-1", title: "Trip plan" });
    expect(chats[0]?.messages.map((m) => m.text)).toEqual([
      "Plan a day in Lisbon",
      "Start in Alfama.",
    ]);
  });

  it("says so when the file is something else", () => {
    expect(() => parseExport({ hello: 1 })).toThrow(/does not look like/);
    expect(() => parseExport([{ other: true }])).toThrow(/does not look like/);
  });
});

describe("readExportFile", () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it("reads conversations.json on its own", async () => {
    const file = new File([enc(claude)], "conversations.json");
    expect((await readExportFile(file)).chats).toHaveLength(1);
  });

  it("finds the chats inside the zip, split files too, and skips the rest", async () => {
    const zip = zipSync({
      "user.json": enc({ email: "x" }),
      "conversations-000.json": enc([chatGpt[0]]),
      "conversations-001.json": enc([chatGpt[1]]),
      "audio/voice.dat": new Uint8Array(50_000),
    });
    const parsed = await readExportFile(new File([zip], "export.zip"));
    expect(parsed.source).toBe("chatgpt");
    // Newest first.
    expect(parsed.chats.map((c) => c.externalId)).toEqual(["c-1", "c-2"]);
  });

  it("explains a zip with no chats and a file that is not an export", async () => {
    const zip = zipSync({ "user.json": enc({}) });
    await expect(readExportFile(new File([zip], "x.zip"))).rejects.toThrow(/No conversations/);
    await expect(readExportFile(new File(["hello"], "x.json"))).rejects.toThrow(/not a readable/);
  });
});

describe("batches", () => {
  const chat = (id: string, chars: number) => ({
    externalId: id,
    title: id,
    createdAt: "",
    updatedAt: "",
    messages: [{ role: "user" as const, text: "x".repeat(chars), at: "" }],
  });

  it("keeps each batch small and trims one enormous chat", () => {
    const out = batches([chat("a", 900_000), chat("b", 900_000), chat("c", 10), chat("d", 4e6)]);
    expect(out.map((b) => b.map((c) => c.externalId))).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(out[2]?.[0]?.messages[0]?.text.length).toBeLessThan(1_500_000);
    expect(batches(Array.from({ length: 120 }, (_, i) => chat(String(i), 5)))).toHaveLength(3);
  });

  it("knows which zip entries hold chats", () => {
    expect(isChatsFile("conversations.json")).toBe(true);
    expect(isChatsFile("export/conversations-012.json")).toBe(true);
    expect(isChatsFile("shared_conversations.json")).toBe(false);
  });
});
