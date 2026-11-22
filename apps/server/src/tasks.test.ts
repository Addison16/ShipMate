import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ApprovalDto, MessageDto, ServerEvent, TaskDto } from "@shipmate/core";
import { tasks as tasksTable, users as usersTable } from "@shipmate/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_TASK_ROUNDS } from "./services/tasks.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/** What one fake model call sees: who is answering, and the newest thing said to it. */
interface Call {
  who: string;
  /** The newest message: the person's words, a Shipmate note, or a tool's result. */
  last: string;
  /** Everything in the request, for looser checks. */
  all: string;
}
type Brain = (call: Call) => AssistantMessage | Promise<AssistantMessage>;

describe.skipIf(!db)("background tasks: the Captain as orchestrator", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };
  /**
   * Tasks run side by side, so the fake model answers by who is asking instead of in a fixed
   * order.
   */
  const think = (brain: Brain) =>
    t.faux.setResponses(
      Array.from({ length: 60 }, () => (context: { messages: unknown[] }) => {
        const all = JSON.stringify(context);
        const who = /You are (\w+), a crew member of a self-hosted/.exec(all)?.[1] ?? "?";
        return brain({ who, last: JSON.stringify(context.messages.at(-1) ?? ""), all });
      }),
    );
  const listMessages = async (conversationId: string): Promise<MessageDto[]> =>
    (await api("GET", `/api/conversations/${conversationId}/messages`)).json().messages;
  const listTasks = async (conversationId?: string): Promise<TaskDto[]> =>
    (
      await api("GET", `/api/tasks${conversationId ? `?conversationId=${conversationId}` : ""}`)
    ).json().tasks;
  const said = (messages: MessageDto[]) =>
    messages.map((m) => `${m.author.kind === "system" ? "Shipmate" : m.author.name}: ${m.content}`);

  async function open() {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    const cards: ApprovalDto[] = [];
    ws.on("message", (raw: Buffer) => {
      const e = JSON.parse(raw.toString()) as ServerEvent;
      events.push(e);
      if (e.type === "approval_request") cards.push(e.approval);
    });
    const busy = () => {
      const last = events.filter((e) => e.type === "status" && e.conversationId === conv.id).at(-1);
      return last?.type === "status" && last.busy;
    };
    /** Send and wait until the Captain's own reply is done (tasks may still be running). */
    const send = async (text: string) => {
      const before = events.length;
      ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text }));
      await until(() =>
        events
          .slice(before)
          .some((e) => e.type === "status" && e.conversationId === conv.id && !e.busy),
      );
    };
    /** Every task from this chat has ended and the Captain has nothing left to say. */
    const settled = () =>
      until(async () => {
        const all = await listTasks(conv.id);
        const openTasks = all.some((x) => ["queued", "running", "waiting"].includes(x.status));
        if (openTasks || busy()) return false;
        // The Captain's turn about a result starts a moment after the task ends.
        await new Promise((r) => setTimeout(r, 150));
        return !busy();
      });
    return { id: conv.id as string, ws, events, cards, send, settled, busy };
  }

  beforeAll(async () => {
    t = await testApp(db as string, { watches: false });
    const setup = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
    });
    cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    for (const [slug, name, role] of [
      ["galley", "Galley", "meal planning"],
      ["lookout", "Lookout", "research"],
    ]) {
      await api("POST", "/api/crew", { slug, name, role, persona: `# ${name}` });
    }
  });
  afterAll(async () => {
    await t?.app.close();
  });
  beforeEach(async () => {
    await api("PUT", "/api/settings", { tasksAtOnce: 3 });
  });

  it("hands work over, stays free to chat, and reports the result when it is done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let note = "";
    let brief = "";
    let captainPrompt = "";
    let asked = "";
    think(async ({ who, last, all }) => {
      if (who === "Galley") {
        brief = last;
        await gate;
        return fauxAssistantMessage("Tuesday: lentil curry. Wednesday: pasta.");
      }
      captainPrompt = all;
      if (last.includes("What's for dinner")) {
        return fauxAssistantMessage([
          fauxText("Asking Galley."),
          fauxToolCall("delegate", {
            crew: "galley",
            task: "Plan two vegetarian dinners",
            title: "Plan dinners",
          }),
        ]);
      }
      if (last.includes("is now with Galley")) return fauxAssistantMessage("Galley is on it.");
      if (last.includes("How is it going")) {
        asked = last;
        return fauxAssistantMessage("Still cooking.");
      }
      if (last.includes("is done")) {
        note = last;
        return fauxAssistantMessage("Dinners are planned: curry, then pasta.");
      }
      return fauxAssistantMessage("?");
    });

    const chat = await open();
    await chat.send("What's for dinner this week?");
    // The Captain's reply ended while Galley is still working: the chat is free again.
    const [task] = await listTasks(chat.id);
    expect(task).toMatchObject({
      number: 1,
      title: "Plan dinners",
      status: "running",
      crew: { slug: "galley", name: "Galley" },
      parentConversationId: chat.id,
    });
    expect(captainPrompt).toContain("runs in the background");
    await until(() => brief !== "");
    expect(brief).toContain("Plan two vegetarian dinners");
    expect(brief).toContain("ask_person");

    // The person keeps chatting, and the Captain is told what is still open.
    await chat.send("How is it going?");
    expect(asked).toContain('task 1: \\"Plan dinners\\" with Galley (galley), working');

    release();
    await chat.settled();
    chat.ws.terminate();

    expect(note).toContain('Task 1 \\"Plan dinners\\" is done');
    expect(note).toContain("Tuesday: lentil curry");
    expect(note).toContain("continue_task 1");
    expect(said(await listMessages(chat.id))).toEqual([
      "Addison: What's for dinner this week?",
      "Captain: Asking Galley.",
      "Shipmate: Captain gave Galley a task: Plan dinners",
      "Captain: Galley is on it.",
      "Addison: How is it going?",
      "Captain: Still cooking.",
      "Galley: Tuesday: lentil curry. Wednesday: pasta.",
      "Captain: Dinners are planned: curry, then pasta.",
    ]);
    const messages = await listMessages(chat.id);
    expect(messages[2]?.meta).toMatchObject({
      taskStarted: { id: task?.id, number: 1, crew: { slug: "galley" } },
    });
    expect(messages[6]?.meta).toMatchObject({ task: { id: task?.id, number: 1 } });

    // The task has a chat of its own, with the brief and the full reply.
    const done = (await listTasks(chat.id))[0];
    expect(done).toMatchObject({ status: "done", resultPreview: expect.stringContaining("curry") });
    expect(said(await listMessages(done?.conversationId ?? ""))).toEqual([
      "Shipmate: Captain asked Galley: Plan two vegetarian dinners",
      "Galley: Tuesday: lentil curry. Wednesday: pasta.",
    ]);
    // It stays out of the chat list; the chat it came from leads to it.
    const listed = (await api("GET", "/api/conversations")).json().conversations;
    expect(listed.some((c: { id: string }) => c.id === done?.conversationId)).toBe(false);
    // The person's pages heard about each step.
    const states = chat.events.flatMap((e) => (e.type === "task" ? [e.task.status] : []));
    expect(states).toEqual(expect.arrayContaining(["queued", "running", "done"]));
  });

  it("runs several tasks side by side, within the limit", async () => {
    await api("PUT", "/api/settings", { tasksAtOnce: 2 });
    expect((await api("GET", "/api/settings")).json().tasksAtOnce).toBe(2);
    const gates = new Map<string, () => void>();
    const waitFor = (key: string) =>
      new Promise<void>((r) => {
        gates.set(key, r);
      });
    const notes: string[] = [];
    think(async ({ who, last }) => {
      if (who !== "Captain") {
        const key = /job (\w)/.exec(last)?.[1] ?? "?";
        await waitFor(key);
        return fauxAssistantMessage(`${who} finished job ${key}.`);
      }
      if (last.includes("Three things")) {
        return fauxAssistantMessage([
          fauxToolCall("delegate", { crew: "galley", task: "job a" }),
          fauxToolCall("delegate", { crew: "lookout", task: "job b" }),
          fauxToolCall("delegate", { crew: "lookout", task: "job c" }),
          // Said twice by a forgetful model: no second task starts.
          fauxToolCall("delegate", { crew: "lookout", task: "Job  C" }),
        ]);
      }
      if (last.includes("Shipmate note")) {
        notes.push(last);
        return fauxAssistantMessage("Noted.");
      }
      return fauxAssistantMessage("Three tasks under way.");
    });
    const chat = await open();
    await chat.send("Three things please");
    await until(() => gates.size === 2);
    expect((await listTasks(chat.id)).map((x) => `${x.number}:${x.status}`).sort()).toEqual([
      "1:running",
      "2:running",
      "3:queued",
    ]);
    // A slot frees up: the waiting task starts.
    gates.get("a")?.();
    await until(() => gates.has("c"));
    gates.get("b")?.();
    gates.get("c")?.();
    await chat.settled();
    chat.ws.terminate();
    expect((await listTasks(chat.id)).map((x) => x.status)).toEqual(["done", "done", "done"]);
    expect(notes.join("\n")).toContain("Task 3");
    const replies = said(await listMessages(chat.id)).filter((line) => line.includes("finished"));
    expect(replies.sort()).toEqual([
      "Galley: Galley finished job a.",
      "Lookout: Lookout finished job b.",
      "Lookout: Lookout finished job c.",
    ]);
  });

  it("does not start the same job again until the person writes again", async () => {
    const refusals: string[] = [];
    let handed = 0;
    think(({ who, last }) => {
      if (who === "Galley") return fauxAssistantMessage("Soup.");
      if (last.includes("was exactly this")) {
        refusals.push(last);
        return fauxAssistantMessage("Galley says soup.");
      }
      // A model stuck on its tool: it hands the same job over whatever it is told.
      handed++;
      return fauxAssistantMessage([fauxToolCall("delegate", { crew: "galley", task: "Lunch" })]);
    });
    const chat = await open();
    await chat.send("Lunch?");
    await chat.settled();
    expect((await listTasks(chat.id)).map((x) => `${x.number}:${x.status}`)).toEqual(["1:done"]);
    expect(refusals.join("\n")).toContain("check_task 1");
    // Asked again in a new message, it may run again.
    const before = handed;
    await chat.send("Lunch again please");
    await chat.settled();
    chat.ws.terminate();
    expect(handed).toBeGreaterThan(before);
    expect((await listTasks(chat.id)).map((x) => x.number).sort()).toEqual([1, 2]);
  });

  it("sends a result back with notes, a limited number of times", async () => {
    let rounds = 0;
    let refused = "";
    const briefs: string[] = [];
    think(({ who, last }) => {
      if (who === "Lookout") {
        briefs.push(last);
        return fauxAssistantMessage(`Draft ${briefs.length}.`);
      }
      if (last.includes("Shipmate note")) {
        rounds++;
        return fauxAssistantMessage([
          fauxToolCall("delegate", {
            crew: "lookout",
            task: "Add the prices",
            continue_task: "1",
          }),
        ]);
      }
      if (last.includes("Compare kettles")) {
        return fauxAssistantMessage([
          fauxToolCall("delegate", { crew: "lookout", task: "Compare two kettles" }),
        ]);
      }
      if (last.includes("already sent back")) {
        refused = last;
        return fauxAssistantMessage("Lookout could not get the prices. Shall I try another way?");
      }
      return fauxAssistantMessage("On it.");
    });
    const chat = await open();
    await chat.send("Compare kettles");
    await chat.settled();
    chat.ws.terminate();
    // The first result and each of the three sent back; the fourth try is refused.
    expect(rounds).toBe(MAX_TASK_ROUNDS + 1);
    expect(refused).toContain("ask how they want to go on");
    expect(briefs).toHaveLength(MAX_TASK_ROUNDS + 1);
    expect(briefs[1]).toContain("Add the prices");
    const [task] = await listTasks(chat.id);
    expect(task).toMatchObject({ number: 1, status: "done" });
    // One task and one chat for all of it, so Lookout kept its earlier work.
    expect(said(await listMessages(task?.conversationId ?? "")).slice(0, 4)).toEqual([
      "Shipmate: Captain asked Lookout: Compare two kettles",
      "Lookout: Draft 1.",
      "Shipmate: Captain told Lookout: Add the prices",
      "Lookout: Draft 2.",
    ]);
    expect(said(await listMessages(chat.id)).at(-1)).toBe(
      "Captain: Lookout could not get the prices. Shall I try another way?",
    );
  });

  it("shows a task's question in the chat it came from, and waits for the answer", async () => {
    think(({ who, last }) => {
      if (who === "Galley") {
        if (last.includes("answered: Saturday")) return fauxAssistantMessage("Picnic on Saturday.");
        return fauxAssistantMessage([
          fauxToolCall("ask_person", {
            question: "Which day?",
            options: [{ label: "Saturday" }, { label: "Sunday" }],
          }),
        ]);
      }
      if (last.includes("Plan a picnic")) {
        return fauxAssistantMessage([
          fauxToolCall("delegate", { crew: "galley", task: "Plan the picnic food" }),
        ]);
      }
      return fauxAssistantMessage("Okay.");
    });
    const chat = await open();
    await chat.send("Plan a picnic");
    await until(() => chat.cards.length === 1);
    const [task] = await listTasks(chat.id);
    expect(chat.cards[0]).toMatchObject({
      conversationId: task?.conversationId,
      parentConversationId: chat.id,
      question: { text: "Which day?" },
    });
    await until(async () => (await listTasks(chat.id))[0]?.status === "waiting");
    await api("POST", `/api/approvals/${chat.cards[0]?.id}`, {
      decision: "allow",
      answer: "Saturday",
    });
    await chat.settled();
    chat.ws.terminate();
    expect((await listTasks(chat.id))[0]).toMatchObject({ status: "done", error: null });
    expect(said(await listMessages(chat.id))).toContain("Galley: Picnic on Saturday.");
  });

  it("stops a task from its card, and tells the Captain about a failed one", async () => {
    let note = "";
    let endSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      endSlow = r;
    });
    let hold!: () => void;
    const held = new Promise<void>((r) => {
      hold = r;
    });
    think(async ({ who, last }) => {
      if (who === "Galley") {
        await slowGate;
        return fauxAssistantMessage("too late");
      }
      if (who === "Lookout") {
        await held;
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "400 invalid request: the model refused the tools",
        });
      }
      if (last.includes("Two jobs")) {
        return fauxAssistantMessage([
          fauxToolCall("delegate", { crew: "galley", task: "slow job" }),
          fauxToolCall("delegate", { crew: "lookout", task: "broken job" }),
        ]);
      }
      if (last.includes("Shipmate note")) {
        note = last;
        return fauxAssistantMessage("Lookout hit a problem.");
      }
      return fauxAssistantMessage("Both under way.");
    });
    const chat = await open();
    await chat.send("Two jobs");
    const both = await listTasks(chat.id);
    const slow = both.find((x) => x.number === 1);
    // The fake model cannot be cut off mid-call the way a real one is, so it is let go here.
    const stopping = api("POST", `/api/tasks/${slow?.id}/stop`);
    await new Promise((r) => setTimeout(r, 100));
    endSlow();
    expect((await stopping).statusCode).toBe(200);
    await until(
      async () => (await listTasks(chat.id)).find((x) => x.number === 1)?.status === "stopped",
    );
    hold();
    await chat.settled();
    chat.ws.terminate();
    const ended = await listTasks(chat.id);
    expect(ended.find((x) => x.number === 2)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("refused the tools"),
    });
    // Only the failure is reported; a task the person stopped needs no report.
    expect(note).toContain("could not be finished");
    expect(note).not.toContain("slow job");
    const lines = said(await listMessages(chat.id));
    expect(lines.some((l) => l.startsWith('Shipmate: Lookout could not finish "Broken job"'))).toBe(
      true,
    );
    expect(lines.at(-1)).toBe("Captain: Lookout hit a problem.");
    // Stopping one that has ended changes nothing, and tasks need a signed-in person.
    expect((await api("POST", `/api/tasks/${slow?.id}/stop`)).json().task.status).toBe("stopped");
    expect((await t.app.inject({ method: "GET", url: "/api/tasks" })).statusCode).toBe(401);
  });

  it("deletes a chat's tasks with it, and marks tasks cut off by a restart", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    think(async ({ who, last }) => {
      if (who === "Galley") {
        await gate;
        return fauxAssistantMessage("late");
      }
      if (last.includes("Go")) {
        return fauxAssistantMessage([fauxToolCall("delegate", { crew: "galley", task: "wait" })]);
      }
      return fauxAssistantMessage("Started.");
    });
    const chat = await open();
    await chat.send("Go");
    const [task] = await listTasks(chat.id);
    expect(task?.status).toBe("running");

    // Deleting the chat stops its task and takes the task's chat with it. (The fake model
    // cannot be cut off mid-call the way a real one is, so it is let go here.)
    const deleting = api("DELETE", `/api/conversations/${chat.id}`);
    await new Promise((r) => setTimeout(r, 100));
    release();
    expect((await deleting).statusCode).toBe(200);
    chat.ws.terminate();
    expect(await listTasks(chat.id)).toEqual([]);
    expect(
      (await api("GET", `/api/conversations/${task?.conversationId}/messages`)).statusCode,
    ).toBe(404);
    const left = await t.app.db.select().from(tasksTable);
    expect(left.some((r) => r.id === task?.id)).toBe(false);

    // A restart loses whatever was open: the task says so, and so does the chat it came from.
    const [me] = await t.app.db.select().from(usersTable);
    const other = (await api("POST", "/api/conversations", {})).json().conversation;
    const own = (
      await api("POST", "/api/conversations", { kind: "direct", crewSlug: "galley" })
    ).json().conversation;
    await t.app.db.insert(tasksTable).values({
      userId: me?.id ?? "",
      number: 1,
      parentConversationId: other.id,
      conversationId: own.id,
      crewSlug: "galley",
      title: "Shop for the week",
      prompt: "Shop for the week",
      status: "running",
    });
    expect(await t.app.services.tasks.recover()).toBe(1);
    expect((await listTasks(other.id))[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("restarted"),
    });
    expect(said(await listMessages(other.id)).at(-1)).toBe(
      'Shipmate: Shipmate restarted, so "Shop for the week" was not finished. Ask for it again to restart it.',
    );
  });
});
