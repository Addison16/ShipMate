import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";
import { CrewRegistry } from "./registry.js";
import { createCrewSession } from "./session.js";
import { type CaptainHost, captainTools, memoryTools } from "./tools.js";

const template = new URL("../../../templates/crew/captain", import.meta.url).pathname;
const user = { id: "u1", displayName: "Addison", role: "owner" as const };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "sess-"));
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  runtime.registerNativeProvider(faux.provider);
  const registry = new CrewRegistry(join(root, "crew"));
  const captain = registry.seedCaptain(template, { model: "faux/m" });
  return { root, runtime, faux, registry, captain };
}

describe("createCrewSession", () => {
  it("runs Shipmate tools and streams the reply", async () => {
    const { root, runtime, faux, captain } = await setup();
    const memory = new MemoryStore(captain.dir);
    const delegated: string[] = [];
    const host: CaptainHost = {
      listCrew: async () => [],
      recruit: async () => {
        throw new Error("unused");
      },
      edit: async () => {
        throw new Error("unused");
      },
      retire: async () => {},
      approve: async () => {
        throw new Error("unused");
      },
      delegate: async (slug, task) => {
        delegated.push(`${slug}:${task}`);
        return "Tuesday: pasta.";
      },
      createWatch: async () => ({ id: "w", name: "w" }),
      equip: async () => "",
      installMcp: async () => "ok",
      crewSettings: async () => "",
      listPeople: async () => "",
      updatePerson: async () => "",
      updateHousehold: async () => "",
    };
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("remember", { name: "diet", description: "veggie", body: "No meat." }),
        fauxToolCall("delegate", { crew: "galley", task: "plan dinner" }),
      ]),
      fauxAssistantMessage("Galley has it covered."),
    ]);
    const s = await createCrewSession({
      crew: captain,
      agentDir: root,
      modelRuntime: runtime,
      inMemory: true,
      customTools: [...memoryTools(memory, user), ...captainTools(host, user)],
      appendSystemPrompt: [memory.contextFor(user.id)],
    });
    let streamed = "";
    const tools: string[] = [];
    s.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        streamed += e.assistantMessageEvent.delta;
      }
      if (e.type === "tool_execution_end") tools.push(`${e.toolName}:${e.isError ? "err" : "ok"}`);
    });
    await s.prompt("I'm vegetarian, plan dinner");
    s.dispose();
    expect(streamed).toBe("Galley has it covered.");
    expect(tools).toEqual(["remember:ok", "delegate:ok"]);
    expect(delegated).toEqual(["galley:plan dinner"]);
    expect(memory.list("user", "u1")[0]?.name).toBe("diet");
  });

  it("asks before the shell, audits calls and keeps files inside the crew folder", async () => {
    const { root, runtime, faux, captain } = await setup();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "cat /etc/passwd" }),
        fauxToolCall("read", { path: "/etc/hostname" }),
        fauxToolCall("read", { path: "CREW.md" }),
      ]),
      fauxAssistantMessage("ok"),
    ]);
    const asked: string[] = [];
    const audit: string[] = [];
    const s = await createCrewSession({
      crew: captain,
      agentDir: root,
      modelRuntime: runtime,
      inMemory: true,
      approvals: () => ({
        request: async (call) => {
          asked.push(call.toolName);
          return "deny";
        },
        audit: (call) => audit.push(`${call.toolName}:${call.decision}`),
        remember: async () => {},
      }),
    });
    const results: string[] = [];
    s.subscribe((e) => {
      if (e.type === "tool_execution_end")
        results.push(`${e.toolName}:${e.isError ? "err" : "ok"}`);
    });
    await s.prompt("try things");
    s.dispose();
    expect(results).toEqual(["bash:err", "read:err", "read:ok"]);
    expect(asked).toEqual(["bash"]);
    // The guard blocks the outside read before the approval gate sees it.
    expect(audit).toEqual(["bash:denied", "read:auto"]);
  });

  it("persists to a session file and reopens it", async () => {
    const { root, runtime, faux, captain } = await setup();
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    const a = await createCrewSession({ crew: captain, agentDir: root, modelRuntime: runtime });
    await a.prompt("one");
    const file = a.sessionFile;
    a.dispose();
    expect(file).toBeTruthy();
    const b = await createCrewSession({
      crew: captain,
      agentDir: root,
      modelRuntime: runtime,
      sessionFile: file as string,
    });
    expect(b.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
    await b.prompt("two");
    expect(b.session.messages.filter((m) => m.role === "user")).toHaveLength(2);
    b.dispose();
  });

  it("runs the shell through the workspace's operations and confines files to it", async () => {
    const { root, runtime, faux, captain } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "ws-"));
    const ran: Array<{ command: string; cwd: string }> = [];
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo sandboxed" }),
        fauxToolCall("write", { path: join(captain.dir, "x.txt"), content: "no" }),
        fauxToolCall("write", { path: "notes.txt", content: "yes" }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    const s = await createCrewSession({
      crew: captain,
      agentDir: root,
      modelRuntime: runtime,
      inMemory: true,
      workspace: {
        dir,
        bash: {
          exec: async (command, cwd, { onData }) => {
            ran.push({ command, cwd });
            onData(Buffer.from("sandboxed\n"));
            return { exitCode: 0 };
          },
        },
      },
    });
    const results: Array<{ name: string; error: boolean }> = [];
    s.subscribe((e) => {
      if (e.type === "tool_execution_end") results.push({ name: e.toolName, error: e.isError });
    });
    await s.prompt("go");
    s.dispose();
    expect(ran).toEqual([{ command: "echo sandboxed", cwd: dir }]);
    expect(results).toHaveLength(3);
    expect(results).toEqual(
      expect.arrayContaining([
        { name: "bash", error: false },
        { name: "write", error: true },
        { name: "write", error: false },
      ]),
    );
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});
