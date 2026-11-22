import { describe, expect, it } from "vitest";
import {
  type ActingUser,
  type CaptainHost,
  captainTools,
  type DelegateSpec,
  type EditSpec,
  type EquipSpec,
  type PersonChanges,
  questionTools,
} from "./tools.js";

function setup(role: ActingUser["role"] = "owner") {
  const edits: Array<[string, EditSpec]> = [];
  const people: Array<[string, PersonChanges]> = [];
  const equips: Array<[string, EquipSpec]> = [];
  const delegated: DelegateSpec[] = [];
  const host: CaptainHost = {
    listCrew: async () => [],
    listModels: async () => "",
    recruit: async () => {
      throw new Error("unused");
    },
    edit: async (slug, spec) => {
      edits.push([slug, spec]);
      return {
        slug,
        name: "Galley",
        role: "meals",
        model: "faux/m",
        status: "active",
        captain: false,
      };
    },
    retire: async () => {},
    approve: async (slug) => ({
      slug,
      name: "Galley",
      role: "meals",
      model: "faux/m",
      status: "active",
      captain: false,
    }),
    delegate: async (spec) => {
      delegated.push(spec);
      return spec.task.startsWith("wait")
        ? { kind: "reply", text: "Tuesday: pasta." }
        : { kind: "started", text: "Task 1 is now with Galley." };
    },
    listTasks: async () => "- task 1",
    checkTask: async (n) => `task ${n}`,
    stopTask: async (n) => `stopped ${n}`,
    createWatch: async () => ({ id: "w", name: "w" }),
    installMcp: async () => "ok",
    listMcpCatalog: async () => "",
    equip: async (slug, grant) => {
      equips.push([slug, grant]);
      return "equipped";
    },
    crewSettings: async (slug) => `name: ${slug}`,
    listPeople: async () => "people",
    updatePerson: async (person, changes) => {
      people.push([person, changes]);
      return "ok";
    },
    updateHousehold: async () => "household",
  };
  const user: ActingUser = { id: "u1", displayName: "Addison", role };
  const tools = Object.fromEntries(captainTools(host, user).map((t) => [t.name, t]));
  // biome-ignore lint/suspicious/noExplicitAny: test calls tools with plain params
  const run = (name: string, params: any) =>
    // biome-ignore lint/style/noNonNullAssertion: the tool exists
    tools[name]!.execute("call", params, undefined, undefined, {} as never);
  return { edits, people, equips, delegated, run };
}

const said = (result: { content: unknown[] }) =>
  (result.content[0] as { text?: string } | undefined)?.text ?? "";

describe("delegate and the task tools", () => {
  it("starts a task in the background and passes on what the server says next", async () => {
    const { delegated, run } = setup();
    const result = await run("delegate", {
      crew: "galley",
      task: "plan dinner",
      title: " Dinner ",
    });
    expect(delegated).toEqual([{ crew: "galley", task: "plan dinner", title: "Dinner" }]);
    expect(said(result)).toBe("Task 1 is now with Galley.");
  });

  it("returns the reply with a note to check it when the crew member answered in the turn", async () => {
    const result = await setup().run("delegate", { crew: "galley", task: "wait for dinner" });
    expect(said(result)).toContain("Tuesday: pasta.");
    expect(said(result)).toContain("continue_task");
  });

  it("reads a task number however a model writes it", async () => {
    const { delegated, run } = setup();
    await run("delegate", { crew: "galley", task: "add a dessert", continue_task: "task 3" });
    await run("delegate", { crew: "galley", task: "add a starter", continue_task: 2 });
    await run("delegate", { crew: "galley", task: "new job", continue_task: "" });
    expect(delegated.map((d) => d.continueTask)).toEqual([3, 2, undefined]);
    expect(said(await run("check_task", { task: "#4" }))).toBe("task 4");
    expect(said(await run("stop_task", { task: 5 }))).toBe("stopped 5");
    expect(said(await run("list_tasks", {}))).toBe("- task 1");
    await expect(run("check_task", { task: "the dinner one" })).rejects.toThrow("task's number");
  });
});

describe("Captain settings tools", () => {
  it("maps edit_crew_member fields onto crew.yaml settings", async () => {
    const { edits, run } = setup();
    await run("edit_crew_member", {
      slug: "galley",
      backend: "claude-code-cli",
      cliModel: "sonnet",
      cliPermissionMode: "plan",
      approval: "never-for",
      neverFor: ["bash"],
      monthlyCapUsd: 0,
      skills: ["meal-plan"],
    });
    expect(edits).toEqual([
      [
        "galley",
        {
          backend: "claude-code-cli",
          cli: { model: "sonnet", permissionMode: "plan" },
          approval: { "never-for": ["bash"] },
          monthlyCapUsd: null,
          skills: ["meal-plan"],
        },
      ],
    ]);
  });

  it("refuses never-for without tools, and members changing the crew", async () => {
    await expect(
      setup().run("edit_crew_member", { slug: "g", approval: "never-for" }),
    ).rejects.toThrow("neverFor");
    await expect(setup("member").run("edit_crew_member", { slug: "g", name: "X" })).rejects.toThrow(
      "only an owner or admin",
    );
    await expect(setup("member").run("update_household", { location: "Oslo" })).rejects.toThrow(
      "only an owner or admin",
    );
  });

  it('updates a person, with "me" meaning the person talking', async () => {
    const { people, run } = setup("member");
    await run("update_person", { person: "me", diet: "vegetarian", monthlyCapUsd: 0 });
    await run("update_person", { person: "Sam", timezone: "Europe/Oslo" });
    expect(people).toEqual([
      ["u1", { diet: "vegetarian", monthlyCapUsd: null }],
      ["Sam", { timezone: "Europe/Oslo" }],
    ]);
  });
});

describe("equip_crew_member", () => {
  it("passes what to add, without the reason", async () => {
    const { equips, run } = setup();
    await run("equip_crew_member", { slug: "navigator", reason: "PRs", mcp: ["github"] });
    expect(equips).toEqual([["navigator", { mcp: ["github"] }]]);
    await expect(run("equip_crew_member", { slug: "navigator", reason: "x" })).rejects.toThrow(
      "at least one",
    );
    await expect(
      setup("member").run("equip_crew_member", { slug: "n", reason: "x", mcp: ["github"] }),
    ).rejects.toThrow("only an owner or admin");
  });
});

describe("ask_person", () => {
  const ask = async (answer: string | null, params: unknown) => {
    const asked: unknown[] = [];
    const [tool] = questionTools(
      {
        ask: async (q) => {
          asked.push(q);
          return answer;
        },
      },
      "Addison",
    );
    // biome-ignore lint/style/noNonNullAssertion: one tool
    const result = await tool!.execute("call", params as never, undefined, undefined, {} as never);
    return { asked, text: (result.content[0] as { text: string }).text };
  };

  it("shows the choices and returns the answer", async () => {
    const { asked, text } = await ask("Saturday", {
      question: " Which day? ",
      options: [{ label: "Saturday" }, { label: "Sunday", detail: "after lunch" }],
    });
    expect(asked).toEqual([
      {
        text: "Which day?",
        options: [{ label: "Saturday" }, { label: "Sunday", detail: "after lunch" }],
      },
    ]);
    expect(text).toBe("Addison answered: Saturday");
  });

  it("tells the crew member to decide when skipped, and needs two choices", async () => {
    const { text } = await ask(null, { question: "Q?", options: [{ label: "a" }, { label: "b" }] });
    expect(text).toContain("best judgment");
    await expect(
      ask("a", { question: "Q?", options: [{ label: "a" }, { label: " " }] }),
    ).rejects.toThrow("two choices");
  });
});
