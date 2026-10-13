import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ApprovalDto, ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("questions with answer buttons, and the Captain equipping crew", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const api = (method: "GET" | "POST" | "PUT", url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
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
    t = await testApp(db as string, { watches: false });
    const setup = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
    });
    cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  /** Send `text` and collect events; `answer` handles each card as it arrives. */
  async function turn(text: string, answer: (a: ApprovalDto) => Promise<void>) {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => {
      const e = JSON.parse(raw.toString()) as ServerEvent;
      events.push(e);
      if (e.type === "approval_request") void answer(e.approval);
    });
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    return { events, messages };
  }

  it("shows a question with choices and carries on with the answer", async () => {
    let seen = "";
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("ask_person", {
          question: "Which day?",
          options: [{ label: "Saturday" }, { label: "Sunday", detail: "after lunch" }],
        }),
      ]),
      (context) => {
        seen = JSON.stringify(context.messages);
        return fauxAssistantMessage("Saturday it is.");
      },
    ]);
    const cards: ApprovalDto[] = [];
    const { events, messages } = await turn("plan the picnic", async (a) => {
      cards.push(a);
      // An answer is required to pick; then the person's choice goes back to the crew member.
      expect((await api("POST", `/api/approvals/${a.id}`, { decision: "allow" })).statusCode).toBe(
        400,
      );
      await api("POST", `/api/approvals/${a.id}`, { decision: "allow", answer: "Saturday" });
    });
    expect(cards).toMatchObject([
      {
        toolName: "ask_person",
        question: {
          text: "Which day?",
          options: [{ label: "Saturday" }, { label: "Sunday", detail: "after lunch" }],
        },
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "approval_resolved", decision: "allow", answer: "Saturday" }),
    );
    const note = messages.find(
      (m: { meta: unknown }) => m.meta && "question" in (m.meta as object),
    );
    expect(note.meta.question).toMatchObject({ text: "Which day?", answer: "Saturday" });
    expect(messages.at(-1).content).toBe("Saturday it is.");
    // The model saw the answer as the tool result.
    expect(seen).toContain("Addison answered: Saturday");
  });

  it("asks before giving a crew member servers and tools, even on auto approval", async () => {
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("equip_crew_member", {
          slug: "captain",
          reason: "to keep the to-do list",
          mcp: ["todoist"],
          skills: ["weekly-plan"],
        }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    const cards: ApprovalDto[] = [];
    await turn("give yourself todoist", async (a) => {
      cards.push(a);
      await api("POST", `/api/approvals/${a.id}`, { decision: "allow" });
    });
    expect(cards).toMatchObject([
      {
        toolName: "equip_crew_member",
        everyTime: true,
        summary: expect.stringMatching(/^Captain wants to give Captain: Todoist.*Why: to keep/),
      },
    ]);
    const manifest = readFileSync(join(t.config.dirs.crew, "captain", "crew.yaml"), "utf8");
    expect(manifest).toMatch(/mcp:.*todoist/s);
    expect(manifest).toMatch(/skills:.*weekly-plan/s);

    // Declined: nothing changes.
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("edit_crew_member", { slug: "captain", mcp: [] })]),
      fauxAssistantMessage("Left it."),
    ]);
    const declined: ApprovalDto[] = [];
    await turn("drop your servers", async (a) => {
      declined.push(a);
      await api("POST", `/api/approvals/${a.id}`, { decision: "deny" });
    });
    expect(declined[0]?.summary).toContain("wants to change what Captain may do");
    expect(readFileSync(join(t.config.dirs.crew, "captain", "crew.yaml"), "utf8")).toMatch(
      /mcp:.*todoist/s,
    );
  });
});
