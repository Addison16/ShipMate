import {
  OPEN_TASK_STATUSES,
  type ServerEvent,
  type TaskDto,
  type TaskRef,
  type TaskStatus,
} from "@shipmate/core";
import { conversations, type Db, tasks, users } from "@shipmate/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";
import { chatTitle } from "../chat/title.js";
import type { CrewService } from "./crew.js";
import type { SettingsService } from "./settings.js";

type TaskRow = typeof tasks.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/** How many times a result can be sent back with notes before the person is asked. */
export const MAX_TASK_ROUNDS = 3;
/** Open tasks one chat may have; a model that keeps handing work over is stopped here. */
export const MAX_OPEN_TASKS = 12;
export const DEFAULT_TASKS_AT_ONCE = 3;
export const MAX_TASKS_AT_ONCE = 8;
/** How much of a result the Captain is given to check; the full reply stays in the task's chat. */
const RESULT_FOR_CAPTAIN = 6000;
const PREVIEW_CHARS = 280;
const OPEN = [...OPEN_TASK_STATUSES];
const AT_ONCE_KEY = "tasksAtOnce";
/** How long a task waits for its chat when the person is writing in it at that moment. */
/** How long a result waits for the reply being written in the chat it goes to. */
const REPORT_WAIT_MS = 30_000;
const BUSY_RETRIES = 30;
const BUSY_WAIT_MS = 2000;

const isOpen = (status: string) => (OPEN as string[]).includes(status);

/** What a round ends with, for whoever waits on it. */
export interface TaskOutcome {
  status: TaskStatus;
  result: string | null;
  error: string | null;
}

/**
 * Background tasks: the Captain hands work to a crew member with `delegate`, and the crew member
 * does it in a chat of its own while the person and the Captain carry on. A few run at a time
 * (Settings, "Tasks at once"); the rest wait their turn, and tasks in the same Shipyard project
 * run one after another because they share its workspace. When a task ends its result is
 * posted in the chat it came from, and the Captain is told so it can check it and report.
 */
export class TaskService {
  /** Task ids waiting for a slot, oldest first. */
  #queue: string[] = [];
  /** Tasks with a turn in flight in this process, with the project whose workspace they use. */
  #running = new Map<string, { projectId: string | null }>();
  /** Running tasks that wait for the person; they use no model, so they hold no slot. */
  #paused = new Set<string>();
  /** Per task, the prompts still to run: the first brief, then any notes sent after it. */
  #prompts = new Map<string, string[]>();
  /** Tasks someone stopped while their turn was running. */
  #stopping = new Set<string>();
  /** Tasks whose result goes back to a waiting tool call instead of waking the Captain. */
  #quiet = new Set<string>();
  #waiters = new Map<string, Array<(outcome: TaskOutcome) => void>>();

  constructor(
    private readonly db: Db,
    private readonly crew: CrewService,
    private readonly bridge: Bridge,
    private readonly settings: SettingsService,
    private readonly emit: (userId: string, event: ServerEvent) => void,
  ) {}

  // ---------- reading ----------

  /**
   * One person's tasks, newest first: those of one chat (the chat they came from, or a task's
   * own chat), or without it every open task and the latest finished ones.
   */
  async list(user: UserRow, conversationId?: string): Promise<TaskDto[]> {
    const rows = conversationId
      ? await this.db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.userId, user.id),
              or(
                eq(tasks.parentConversationId, conversationId),
                eq(tasks.conversationId, conversationId),
              ),
            ),
          )
          .orderBy(desc(tasks.createdAt))
          .limit(200)
      : await this.db
          .select()
          .from(tasks)
          .where(eq(tasks.userId, user.id))
          // Open ones always make the list, then the newest.
          .orderBy(
            sql`${tasks.status} in ('queued', 'running', 'waiting') desc`,
            desc(tasks.createdAt),
          )
          .limit(100);
    return rows.map((r) => this.#dto(r));
  }

  /** The tasks handed over in a chat, for the Captain's `list_tasks`. */
  async describe(parentConversationId: string): Promise<string> {
    const rows = await this.#of(parentConversationId);
    if (!rows.length) return "No tasks have been handed over in this chat yet.";
    return rows.map((r) => this.#line(r)).join("\n");
  }

  /** One task in full, for the Captain's `check_task`. */
  async check(parentConversationId: string, number: number): Promise<string> {
    const row = await this.#numbered(parentConversationId, number);
    const reply = row.result?.trim();
    return [
      this.#line(row),
      "",
      `Asked: ${row.prompt}`,
      "",
      reply
        ? `${isOpen(row.status) ? "Their last reply so far" : "Their reply"}:\n\n${forCaptain(reply)}`
        : isOpen(row.status)
          ? "No reply yet. You get it when the task is done; do not keep checking."
          : "It ended without a reply.",
    ].join("\n");
  }

  /**
   * A line for the Captain about the tasks still open in a chat, added to the person's message
   * so it can answer "how is it going" without a tool call. Empty when there are none.
   */
  async statusNote(parentConversationId: string, personName: string): Promise<string> {
    const open = (await this.#of(parentConversationId)).filter((r) => isOpen(r.status));
    if (!open.length) return "";
    return [
      `[Shipmate note, not written by ${personName}. Tasks still open in this chat:`,
      ...open.map((r) => this.#line(r)),
      "Their results come to you when they are done. Use check_task to read one, stop_task to stop one, and delegate with continue_task to give one new instructions.]",
    ].join("\n");
  }

  async openCount(parentConversationId: string): Promise<number> {
    return (await this.#of(parentConversationId)).filter((r) => isOpen(r.status)).length;
  }

  // ---------- starting ----------

  /**
   * Hand `prompt` to a crew member as a new task from the chat `parent`. The task gets a chat
   * of its own and a card in `parent`, then starts as soon as a slot is free. `quiet`: the
   * caller waits for the outcome itself (see settled), so the Captain is not woken for it.
   */
  async start(
    user: UserRow,
    parent: ConversationRow,
    spec: { crewSlug: string; prompt: string; title?: string | undefined },
    options: {
      from: { slug: string; name: string };
      quiet?: boolean;
      /** The Captain is acting on a task's result, not on a message from the person. */
      unprompted?: boolean;
      /** When the person last wrote in `parent`: the same job is not started twice since. */
      since?: Date | undefined;
    },
  ): Promise<{ task: TaskDto; queued: boolean; already: boolean }> {
    const prompt = spec.prompt.trim();
    if (!prompt) throw new Error("say what the task is");
    const before = await this.#of(parent.id);
    const open = before.filter((r) => isOpen(r.status));
    // A model that repeats its tool call must not start the same work twice.
    const same = open.find(
      (r) => r.crewSlug === spec.crewSlug && squash(r.prompt) === squash(prompt),
    );
    if (same) return { task: this.#dto(same), queued: same.status === "queued", already: true };
    // Given a result, a small model may hand the very same job over again: that would loop.
    // Only a new message from the person can ask for the same thing twice.
    const since = options.since;
    const again = before.find(
      (r) =>
        r.crewSlug === spec.crewSlug &&
        squash(r.prompt) === squash(prompt) &&
        (options.unprompted || (since !== undefined && r.createdAt >= since)),
    );
    if (again) {
      throw new Error(
        `Task ${again.number} was exactly this and has ended; do not hand it over again. Read its result with check_task ${again.number}. To have it fixed, call delegate with continue_task ${again.number} and notes. Otherwise tell ${user.displayName} the outcome.`,
      );
    }
    if (open.length >= MAX_OPEN_TASKS) {
      throw new Error(
        `${open.length} tasks are already open in this chat, which is the most allowed. Wait for some to finish, or stop one with stop_task.`,
      );
    }
    const member = this.crew.folder(spec.crewSlug);
    const crewRow = await this.crew.row(spec.crewSlug);
    const title = (spec.title?.trim() || chatTitle(prompt)).slice(0, 80);
    const row = await this.db.transaction(async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({
          userId: user.id,
          kind: "direct",
          surface: "task",
          crewMemberId: crewRow.id,
          // Work in the same Shipyard project, and as private as the chat it came from.
          projectId: parent.projectId,
          privateChat: parent.privateChat,
          title,
        })
        .returning();
      if (!conv) throw new Error("insert failed");
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${tasks.number}), 0)` })
        .from(tasks)
        .where(eq(tasks.parentConversationId, parent.id));
      const [created] = await tx
        .insert(tasks)
        .values({
          userId: user.id,
          number: Number(last?.n ?? 0) + 1,
          parentConversationId: parent.id,
          conversationId: conv.id,
          crewSlug: spec.crewSlug,
          title,
          prompt,
        })
        .returning();
      if (!created) throw new Error("insert failed");
      return created;
    });
    const ref = this.#ref(row);
    const captain = options.from.name;
    // The card in the chat it came from; its state follows `task` events.
    await this.bridge.post(parent.id, {
      role: "system",
      content: `${captain} gave ${member.manifest.name} a task: ${title}`,
      meta: { taskStarted: { ...ref, from: options.from, prompt } },
    });
    await this.bridge.post(row.conversationId, {
      role: "system",
      content: `${captain} asked ${member.manifest.name}: ${prompt}`,
      meta: { taskBrief: { from: options.from, text: prompt } },
    });
    if (options.quiet) this.#quiet.add(row.id);
    this.#prompts.set(row.id, [
      [
        `${captain} handed you this task for ${user.displayName}. Work on it on your own in this chat, then reply with the result: lead with the answer and keep it easy to scan, because ${captain} and ${user.displayName} both read it.`,
        `If only ${user.displayName} can decide something, ask them with ask_person. For anything else you are unsure about, ask ${captain} with ask_captain instead of guessing.`,
        "",
        "Task:",
        prompt,
      ].join("\n"),
    ]);
    this.#queue.push(row.id);
    this.#changed(row);
    const started = await this.#pump();
    return { task: this.#dto(row), queued: !started.has(row.id), already: false };
  }

  /**
   * Carry on with an earlier task: the crew member gets `notes` in the task's chat, where it
   * still has its work. Notes for a task that is still running wait until its turn ends;
   * sending a finished one back is limited to MAX_TASK_ROUNDS.
   */
  async continue(
    user: UserRow,
    parent: ConversationRow,
    number: number,
    notes: string,
    options: { from: { slug: string; name: string }; quiet?: boolean },
  ): Promise<{ task: TaskDto; queued: boolean }> {
    const text = notes.trim();
    if (!text) throw new Error("say what to change or do next");
    let row = await this.#numbered(parent.id, number);
    if (!isOpen(row.status) && row.rounds >= MAX_TASK_ROUNDS) {
      throw new Error(
        `Task ${number} was already sent back ${row.rounds} times. Do not send it back again: tell ${user.displayName} what is still missing and ask how they want to go on.`,
      );
    }
    const member = this.crew.folder(row.crewSlug);
    await this.bridge.post(row.conversationId, {
      role: "system",
      content: `${options.from.name} told ${member.manifest.name}: ${text}`,
      meta: { taskBrief: { from: options.from, text, followUp: true } },
    });
    await this.bridge.post(parent.id, {
      role: "system",
      content: `${options.from.name} sent "${row.title}" back to ${member.manifest.name}: ${text}`,
      meta: { taskSentBack: { ...this.#ref(row), from: options.from, notes: text } },
    });
    const prompt = [
      `${options.from.name} has more for this task. Carry on from your work above, then reply with the full, updated result.`,
      "",
      "Notes:",
      text,
    ].join("\n");
    if (options.quiet) this.#quiet.add(row.id);
    else this.#quiet.delete(row.id);
    // No await between this check and the push: #work drops a task from #running in the same
    // step in which it finds no more notes, so notes can never land on a task that just ended.
    const inFlight = this.#running.has(row.id) || this.#queue.includes(row.id);
    this.#prompts.set(row.id, [...(this.#prompts.get(row.id) ?? []), prompt]);
    if (inFlight) return { task: this.#dto(row), queued: true };
    row =
      (await this.#set(row.id, {
        status: "queued",
        rounds: row.rounds + 1,
        error: null,
        finishedAt: null,
      })) ?? row;
    this.#queue.push(row.id);
    this.#changed(row);
    const started = await this.#pump();
    return { task: this.#dto(row), queued: !started.has(row.id) };
  }

  /** Resolves when the task's work ends (this round and any notes queued behind it). */
  settled(id: string, signal?: AbortSignal): Promise<TaskOutcome> {
    return new Promise((resolve) => {
      const list = this.#waiters.get(id) ?? [];
      list.push(resolve);
      this.#waiters.set(id, list);
      // The turn that waits was stopped: the work it waits for stops too.
      const stop = () => void this.#stop(id).catch(() => {});
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
  }

  // ---------- stopping ----------

  async stop(user: UserRow, id: string): Promise<TaskDto> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, user.id)));
    if (!row) throw new HttpError(404, "task not found");
    return this.#dto((await this.#stop(id)) ?? row);
  }

  /** `stop_task`: stop by its number in the chat it came from. */
  async stopNumbered(parentConversationId: string, number: number): Promise<string> {
    const row = await this.#numbered(parentConversationId, number);
    if (!isOpen(row.status)) return `Task ${number} had already ended (${row.status}).`;
    await this.#stop(row.id);
    return `Stopped task ${number} ("${row.title}").`;
  }

  async #stop(id: string): Promise<TaskRow | undefined> {
    const row = await this.#row(id);
    if (!row || !isOpen(row.status)) return row;
    this.#prompts.delete(id);
    if (this.#running.has(id)) {
      // Its turn ends on its own once aborted; #work then records the stop.
      this.#stopping.add(id);
      const [owner] = await this.db.select().from(users).where(eq(users.id, row.userId));
      if (owner) await this.bridge.abort(owner, row.conversationId).catch(() => {});
      return this.#row(id);
    }
    this.#queue = this.#queue.filter((q) => q !== id);
    const stopped = await this.#set(id, { status: "stopped", finishedAt: new Date() });
    if (stopped) this.#finish(stopped);
    return stopped;
  }

  /**
   * A chat is being deleted: stop the tasks handed over in it (and the task that lives in it).
   * Returns the chats of the tasks that came from it, which go with it.
   */
  async release(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        or(
          eq(tasks.parentConversationId, conversationId),
          eq(tasks.conversationId, conversationId),
        ),
      );
    for (const r of rows) {
      if (isOpen(r.status)) await this.#stop(r.id).catch(() => {});
    }
    return rows
      .filter((r) => r.parentConversationId === conversationId)
      .map((r) => r.conversationId);
  }

  /**
   * At startup: tasks that were waiting or running when the server stopped are gone with it.
   * They are marked so, with a note in the chat they came from.
   */
  async recover(): Promise<number> {
    const lost = await this.db.select().from(tasks).where(inArray(tasks.status, OPEN));
    for (const row of lost) {
      const ended = await this.#set(row.id, {
        status: "failed",
        error: "Shipmate restarted while this task was open.",
        finishedAt: new Date(),
      });
      if (!ended) continue;
      await this.bridge
        .post(row.parentConversationId, {
          role: "system",
          content: `Shipmate restarted, so "${row.title}" was not finished. Ask for it again to restart it.`,
          meta: { taskEnded: { ...this.#ref(ended), status: "failed", error: ended.error } },
        })
        .catch(() => {});
    }
    return lost.length;
  }

  // ---------- running ----------

  /** How many tasks run at the same time (Settings, "Tasks at once"). */
  async atOnce(): Promise<number> {
    const saved = Number(await this.settings.getJson<unknown>(AT_ONCE_KEY).catch(() => null));
    return Number.isInteger(saved) && saved >= 1
      ? Math.min(saved, MAX_TASKS_AT_ONCE)
      : DEFAULT_TASKS_AT_ONCE;
  }

  async setAtOnce(n: number): Promise<void> {
    await this.settings.setJson(
      AT_ONCE_KEY,
      Math.min(Math.max(1, Math.round(n)), MAX_TASKS_AT_ONCE),
    );
    // A higher number lets waiting tasks start now.
    void this.#pump();
  }

  /** Start waiting tasks while there is room. Returns the ids it started. */
  async #pump(): Promise<Set<string>> {
    const started = new Set<string>();
    const limit = await this.atOnce();
    for (const id of [...this.#queue]) {
      if (this.#running.size - this.#paused.size >= limit) break;
      if (this.#running.has(id)) continue;
      const row = await this.#row(id);
      if (row?.status !== "queued") {
        this.#queue = this.#queue.filter((q) => q !== id);
        continue;
      }
      const [conv] = await this.db
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, row.conversationId));
      const projectId = conv?.projectId ?? null;
      // One Shipyard workspace, one task at a time.
      if (projectId && [...this.#running.values()].some((r) => r.projectId === projectId)) continue;
      // Checked again after the awaits: another pump may have taken it meanwhile.
      if (this.#running.has(id) || !this.#queue.includes(id)) continue;
      this.#queue = this.#queue.filter((q) => q !== id);
      this.#running.set(id, { projectId });
      started.add(id);
      void this.#work(id);
    }
    return started;
  }

  /** One task's turn, then whatever notes queued up behind it, then its report. */
  async #work(id: string): Promise<void> {
    let row: TaskRow | undefined;
    try {
      const before = await this.#row(id);
      if (!before) return;
      row = await this.#set(id, {
        status: "running",
        startedAt: before.startedAt ?? new Date(),
        finishedAt: null,
        error: null,
      });
      if (!row) return;
      this.#changed(row);
      const [owner] = await this.db.select().from(users).where(eq(users.id, row.userId));
      if (!owner) throw new Error("the person this task was for is gone");
      for (;;) {
        const prompt = this.#prompts.get(id)?.shift();
        let ended: Pick<TaskRow, "status" | "result" | "error">;
        if (prompt === undefined) {
          // Nothing to run (its notes went with a stop): it stays as it stood.
          ended = {
            status: this.#stopping.has(id) ? "stopped" : "done",
            result: row.result,
            error: null,
          };
        } else {
          try {
            const turn = await this.#turn(owner, row, prompt);
            const text = turn.text.trim();
            ended =
              this.#stopping.has(id) || turn.aborted
                ? { status: "stopped", result: text || row.result, error: null }
                : text
                  ? { status: "done", result: text, error: null }
                  : { status: "failed", result: row.result, error: "It ended without a reply." };
          } catch (err) {
            const partial = (err as { partial?: unknown }).partial;
            const stopped = this.#stopping.has(id);
            ended = {
              status: stopped ? "stopped" : "failed",
              result: typeof partial === "string" && partial ? partial : row.result,
              error: stopped ? null : err instanceof Error ? err.message : String(err),
            };
          }
        }
        this.#paused.delete(id);
        const more = () => ended.status === "done" && (this.#prompts.get(id)?.length ?? 0) > 0;
        // Notes that arrived meanwhile run next; a stop or a failure ends it here.
        if (more()) {
          row = (await this.#set(id, { status: "running", result: ended.result })) ?? row;
          continue;
        }
        row = await this.#set(id, { ...ended, finishedAt: new Date() });
        if (!row) break;
        // Notes that arrived during that write: carry on rather than lose them.
        if (more()) {
          row = (await this.#set(id, { status: "running", finishedAt: null })) ?? row;
          continue;
        }
        // From here on new notes start a new round (see continue), so they are never dropped.
        this.#running.delete(id);
        this.#prompts.delete(id);
        break;
      }
    } catch (err) {
      row = await this.#set(id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      }).catch(() => undefined);
    } finally {
      if (this.#running.delete(id)) this.#prompts.delete(id);
      this.#paused.delete(id);
      this.#stopping.delete(id);
    }
    const quiet = this.#quiet.delete(id);
    // No row: the task's chat was deleted while it ran, and there is nothing left to report.
    if (row) this.#finish(row);
    // The slot is free now; reporting may wait a moment for the chat it goes to.
    void this.#pump();
    if (row) {
      await this.#report(row, quiet).catch((err: unknown) =>
        console.error(`shipmate: could not report task "${row?.title}"`, err),
      );
    }
  }

  /** Run one prompt in the task's chat; when the person is writing there right now, wait. */
  async #turn(owner: UserRow, row: TaskRow, prompt: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.bridge.runTurn(owner, row.conversationId, row.crewSlug, prompt, {
          task: { parentConversationId: row.parentConversationId },
          onWaiting: (waiting) => void this.#waiting(row.id, waiting),
        });
      } catch (err) {
        const busy =
          err instanceof HttpError && err.statusCode === 409 && /still answering/.test(err.message);
        if (!busy || attempt >= BUSY_RETRIES || this.#stopping.has(row.id)) throw err;
        await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
      }
    }
  }

  async #waiting(id: string, waiting: boolean) {
    if (waiting) this.#paused.add(id);
    else this.#paused.delete(id);
    // Only while its turn runs, so a late write can never reopen a task that has ended.
    const [row] = await this.db
      .update(tasks)
      .set({ status: waiting ? "waiting" : "running" })
      .where(and(eq(tasks.id, id), inArray(tasks.status, ["running", "waiting"])))
      .returning()
      .catch(() => []);
    if (row && this.#running.has(id)) this.#changed(row);
    // Waiting for the person frees its slot for another task.
    if (waiting) void this.#pump();
  }

  /** Tell the open pages and anyone waiting that a task ended. */
  #finish(row: TaskRow) {
    this.#changed(row);
    const outcome: TaskOutcome = {
      status: row.status as TaskStatus,
      result: row.result,
      error: row.error,
    };
    for (const resolve of this.#waiters.get(row.id) ?? []) resolve(outcome);
    this.#waiters.delete(row.id);
  }

  /** Post how a task ended in the chat it came from, and tell the Captain there. */
  async #report(row: TaskRow, quiet: boolean) {
    if (row.status !== "done" && row.status !== "failed") return;
    // A chat that was deleted meanwhile gets nothing more.
    const [parent] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, row.parentConversationId));
    if (!parent) return;
    // A quick task can end while the Captain is still saying it handed the job over.
    if (!quiet && this.bridge.isBusy(row.parentConversationId)) {
      await this.bridge.whenFree(row.parentConversationId, REPORT_WAIT_MS);
      // Sent back or deleted meanwhile: that round reports for itself.
      const now = await this.#row(row.id);
      if (now?.status !== row.status || now.rounds !== row.rounds) return;
    }
    const ref = this.#ref(row);
    const name = ref.crew.name;
    if (row.status === "done") {
      await this.bridge.post(row.parentConversationId, {
        role: "assistant",
        crewSlug: row.crewSlug,
        content: row.result ?? "",
        meta: { task: ref },
      });
    } else {
      await this.bridge.post(row.parentConversationId, {
        role: "system",
        content: `${name} could not finish "${row.title}": ${row.error ?? "it stopped"}`,
        meta: { taskEnded: { ...ref, status: "failed", error: row.error } },
      });
    }
    if (quiet) return;
    const left = MAX_TASK_ROUNDS - row.rounds;
    const [owner] = await this.db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, row.userId));
    const person = owner?.name ?? "the person";
    const sendBack =
      left > 0
        ? `call delegate with continue_task ${row.number} and say exactly what to fix (you can do this ${left} more ${left === 1 ? "time" : "times"})`
        : `it cannot be sent back again, so tell ${person} what is missing and ask how to go on`;
    const note =
      row.status === "done"
        ? [
            `[Shipmate note, not written by ${person}.]`,
            `Task ${row.number} "${row.title}" is done. ${name}'s reply, which ${person} can already read in this chat:`,
            "",
            "<<<",
            forCaptain(row.result ?? ""),
            ">>>",
            "",
            "What to do now:",
            `1. Check the reply against what ${person} asked for.`,
            `2. If something is wrong or missing, ${sendBack}.`,
            `3. If more work is needed to finish what ${person} asked, hand it over with delegate now.`,
            `4. Otherwise tell ${person} the outcome in 1 to 3 short lines: the result, and any decision they need to make. Do not repeat the whole reply.`,
          ]
        : [
            `[Shipmate note, not written by ${person}.]`,
            `Task ${row.number} "${row.title}" with ${name} could not be finished: ${row.error ?? "it stopped"}`,
            ...(row.result?.trim()
              ? ["", "What they had so far:", "", "<<<", forCaptain(row.result), ">>>"]
              : []),
            "",
            `Tell ${person} in one or two short lines what went wrong. If it is worth another try, ${sendBack}.`,
          ];
    this.bridge.nudge(row.parentConversationId, note.join("\n"));
  }

  // ---------- helpers ----------

  #changed(row: TaskRow) {
    this.emit(row.userId, { type: "task", task: this.#dto(row) });
  }

  async #row(id: string): Promise<TaskRow | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  async #set(
    id: string,
    changes: Partial<Omit<TaskRow, "id" | "userId" | "number">>,
  ): Promise<TaskRow | undefined> {
    const [row] = await this.db.update(tasks).set(changes).where(eq(tasks.id, id)).returning();
    return row;
  }

  /** A chat's tasks, oldest first. */
  #of(parentConversationId: string): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.parentConversationId, parentConversationId))
      .orderBy(tasks.number);
  }

  async #numbered(parentConversationId: string, number: number): Promise<TaskRow> {
    const rows = await this.#of(parentConversationId);
    const row = rows.find((r) => r.number === number);
    if (row) return row;
    throw new Error(
      rows.length
        ? `There is no task ${number} in this chat. The tasks here are: ${rows.map((r) => `${r.number} ("${r.title}")`).join(", ")}.`
        : `There is no task ${number}: no tasks have been handed over in this chat yet.`,
    );
  }

  #crewName(slug: string): string {
    try {
      return this.crew.folder(slug).manifest.name;
    } catch {
      return slug;
    }
  }

  #line(r: TaskRow): string {
    const state: Record<string, string> = {
      queued: "waiting to start",
      running: `working for ${age(r.startedAt ?? r.createdAt)}`,
      waiting: "waiting for the person's answer",
      done: "done",
      failed: `failed: ${r.error ?? "it stopped"}`,
      stopped: "stopped",
    };
    return `- task ${r.number}: "${r.title}" with ${this.#crewName(r.crewSlug)} (${r.crewSlug}), ${state[r.status] ?? r.status}`;
  }

  #ref(r: TaskRow): TaskRef {
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      crew: { slug: r.crewSlug, name: this.#crewName(r.crewSlug) },
      conversationId: r.conversationId,
    };
  }

  #dto(r: TaskRow): TaskDto {
    const result = r.result?.replace(/\s+/g, " ").trim();
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      prompt: r.prompt,
      crew: { slug: r.crewSlug, name: this.#crewName(r.crewSlug) },
      status: r.status as TaskStatus,
      parentConversationId: r.parentConversationId,
      conversationId: r.conversationId,
      resultPreview: result ? clip(result, PREVIEW_CHARS) : null,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** A reply as the Captain gets it: long ones are cut, and it is told where the rest is. */
function forCaptain(reply: string): string {
  return reply.length > RESULT_FOR_CAPTAIN
    ? `${reply.slice(0, RESULT_FOR_CAPTAIN).trimEnd()}…\n(Cut here. The whole reply is in the task's chat, which the person can open.)`
    : reply;
}

/** "under a minute", "4 min", "2 h". */
function age(since: Date): string {
  const minutes = Math.floor((Date.now() - since.getTime()) / 60_000);
  if (minutes < 1) return "under a minute";
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}
