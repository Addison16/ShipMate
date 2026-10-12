import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryStore } from "./memory.js";

/** Who a session is working for. Every tool call is attributed to this person. */
export interface ActingUser {
  id: string;
  displayName: string;
  role: "owner" | "admin" | "member";
}

export interface CrewSummary {
  slug: string;
  name: string;
  role: string;
  model: string;
  status: "active" | "pending_review" | "retired";
  captain: boolean;
}

export interface RecruitSpec {
  slug: string;
  name: string;
  role: string;
  persona: string;
  model?: string | undefined;
  tools?: string[] | undefined;
  mcp?: string[] | undefined;
}

export interface EditSpec {
  name?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  tools?: string[] | undefined;
  mcp?: string[] | undefined;
  persona?: string | undefined;
}

/**
 * What the Captain's tools need from the server: the roster, recruiting, and running a task in
 * another crew member's session within the same conversation.
 */
export interface CaptainHost {
  listCrew(): Promise<CrewSummary[]>;
  recruit(spec: RecruitSpec): Promise<CrewSummary>;
  edit(slug: string, spec: EditSpec): Promise<CrewSummary>;
  retire(slug: string): Promise<void>;
  /** Run `task` with crew member `slug` and return its final reply. */
  delegate(slug: string, task: string, signal: AbortSignal | undefined): Promise<string>;
  /** Schedule a watch (routine) owned by the person in this conversation. */
  createWatch(spec: WatchSpec): Promise<{ id: string; name: string }>;
  /** Install a server from the MCP catalog and give it to crew members. */
  installMcp(id: string, crews: string[]): Promise<string>;
}

export interface WatchSpec {
  name: string;
  crew: string;
  prompt: string;
  cron?: string | undefined;
  timezone?: string | undefined;
  everyMinutes?: number | undefined;
}

/** What the create_skill tool needs: where the skill goes and whether it waits for review. */
export interface SkillHost {
  createSkill(input: {
    scope: "crew" | "user";
    content: string;
  }): Promise<{ id: string; name: string; status: "active" | "pending" }>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** Memory tools every crew member gets. */
export function memoryTools(memory: MemoryStore, user: ActingUser): ToolDefinition[] {
  const scopeParam = Type.Union([Type.Literal("shared"), Type.Literal("user")], {
    description:
      '"user" (default) keeps it private to the person you are talking with; "shared" is visible to everyone on this instance.',
  });
  return [
    defineTool({
      name: "remember",
      label: "Remember",
      description:
        "Save one durable fact to memory: a preference, a decision, a standing instruction or a useful reference. One fact per entry; reuse a name to update it.",
      promptSnippet: "remember: save a durable fact (per person by default, or shared)",
      parameters: Type.Object({
        name: Type.String({ description: "short kebab-case slug, e.g. diet-vegetarian" }),
        description: Type.String({ description: "one line saying what this is about" }),
        body: Type.String({ description: "the fact, with why it matters when known" }),
        type: Type.Optional(
          Type.Union([
            Type.Literal("user"),
            Type.Literal("feedback"),
            Type.Literal("project"),
            Type.Literal("reference"),
          ]),
        ),
        scope: Type.Optional(scopeParam),
      }),
      async execute(_id, p) {
        const scope = p.scope ?? "user";
        try {
          const e = memory.write(scope, user.id, {
            name: p.name,
            description: p.description,
            body: p.body,
            ...(p.type ? { type: p.type } : {}),
          });
          return text(`Saved ${scope} memory "${e.name}".`);
        } catch (err) {
          throw new Error(`could not save memory: ${(err as Error).message}`);
        }
      },
    }),
    defineTool({
      name: "recall",
      label: "Recall",
      description:
        "Read the full text of memory entries. Pass names from the memory index, or omit them to read everything you can see.",
      parameters: Type.Object({
        names: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, p) {
        const all = [...memory.list("shared"), ...memory.list("user", user.id)];
        const picked = p.names?.length ? all.filter((e) => p.names?.includes(e.name)) : all;
        if (!picked.length) return text("No matching memories.");
        return text(
          picked.map((e) => `### ${e.name} (${e.scope}, ${e.type})\n${e.body}`).join("\n\n"),
        );
      },
    }),
    defineTool({
      name: "forget",
      label: "Forget",
      description: "Delete a memory entry that is wrong or no longer true.",
      parameters: Type.Object({ name: Type.String(), scope: Type.Optional(scopeParam) }),
      async execute(_id, p) {
        const scope = p.scope ?? "user";
        if (scope === "shared" && user.role === "member") {
          throw new Error("only an owner or admin can delete shared memory");
        }
        const ok = memory.remove(scope, user.id, p.name);
        return text(ok ? `Forgot "${p.name}".` : `No ${scope} memory called "${p.name}".`);
      },
    }),
  ];
}

/** Every crew member can write down a repeatable procedure as a skill. */
export function skillTools(host: SkillHost): ToolDefinition[] {
  return [
    defineTool({
      name: "create_skill",
      label: "Create skill",
      description:
        "After finishing a task you expect to repeat, save how to do it as a skill (Agent Skills format). New skills usually wait for a person to approve them before they load. Reusing a name replaces that skill.",
      promptSnippet: "create_skill: save a repeatable procedure as a skill",
      parameters: Type.Object({
        name: Type.String({ description: "kebab-case, e.g. weekly-meal-plan" }),
        description: Type.String({
          description: "what it does and when to use it; this is how it gets picked later",
        }),
        instructions: Type.String({ description: "the steps, as markdown instructions" }),
        scope: Type.Optional(
          Type.Union([Type.Literal("crew"), Type.Literal("user")], {
            description: '"crew" (default): yours; "user": only for the person you are helping',
          }),
        ),
      }),
      async execute(_id, p) {
        const content = `---\nname: ${p.name}\ndescription: ${JSON.stringify(p.description)}\n---\n\n${p.instructions.trim()}\n`;
        const s = await host.createSkill({ scope: p.scope ?? "crew", content });
        return text(
          s.status === "pending"
            ? `Saved skill "${s.name}"; it loads once a person approves it on the Skills page.`
            : `Saved skill "${s.name}"; it loads in new conversations.`,
        );
      },
    }),
  ];
}

/** Crew management and delegation, for the Captain only. */
export function captainTools(host: CaptainHost, user: ActingUser): ToolDefinition[] {
  const canManage = user.role === "owner" || user.role === "admin";
  const requireManager = () => {
    if (!canManage) {
      throw new Error(
        `${user.displayName} is a member; only an owner or admin can change the crew. Suggest they ask one.`,
      );
    }
  };
  const roster = (crew: CrewSummary[]) =>
    crew
      .filter((c) => c.status !== "retired")
      .map(
        (c) =>
          `- ${c.slug}: ${c.name}, ${c.role} (model ${c.model}${c.status === "pending_review" ? ", awaiting review" : ""}${c.captain ? ", you" : ""})`,
      )
      .join("\n");
  const stringList = (description: string) =>
    Type.Optional(Type.Array(Type.String(), { description }));

  return [
    defineTool({
      name: "list_crew",
      label: "List crew",
      description: "List the crew members aboard, with their roles and models.",
      parameters: Type.Object({}),
      async execute() {
        return text(roster(await host.listCrew()) || "No crew yet.");
      },
    }),
    defineTool({
      name: "recruit_crew_member",
      label: "Recruit crew member",
      description:
        "Create a new specialist crew member for a recurring kind of work. It starts awaiting review: a person approves it on the Crew page before you can delegate to it.",
      promptSnippet: "recruit_crew_member: create a specialist crew member (needs review)",
      parameters: Type.Object({
        slug: Type.String({ description: "lowercase id, e.g. galley" }),
        name: Type.String({ description: "display name, e.g. Galley" }),
        role: Type.String({ description: "one sentence: what this crew member does" }),
        persona: Type.String({
          description:
            "the CREW.md: who they are, how they work, what to avoid, written as instructions to them",
        }),
        model: Type.Optional(
          Type.String({
            description: "provider/model; omit to follow the crew default set in Settings",
          }),
        ),
        tools: stringList("built-in tools, smallest set that works: read, write, edit, bash, ..."),
        mcp: stringList("MCP server ids, e.g. time, web-search, fetch"),
      }),
      async execute(_id, p) {
        requireManager();
        const c = await host.recruit(p);
        return text(
          `Recruited ${c.name} (${c.slug}). They are awaiting review on the Crew page; tell ${user.displayName} to look over their persona and approve them.`,
        );
      },
    }),
    defineTool({
      name: "edit_crew_member",
      label: "Edit crew member",
      description:
        "Change a crew member's name, role, model, tools, MCP servers or persona (replaces CREW.md entirely when given).",
      parameters: Type.Object({
        slug: Type.String(),
        name: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        tools: stringList("replaces the tool list"),
        mcp: stringList("replaces the MCP server list"),
        persona: Type.Optional(Type.String()),
      }),
      async execute(_id, { slug, ...spec }) {
        requireManager();
        const c = await host.edit(slug, spec);
        return text(`Updated ${c.name}.`);
      },
    }),
    defineTool({
      name: "retire_crew_member",
      label: "Retire crew member",
      description: "Retire a crew member who is no longer needed. Their folder is kept on disk.",
      parameters: Type.Object({ slug: Type.String() }),
      async execute(_id, p) {
        requireManager();
        await host.retire(p.slug);
        return text(`Retired ${p.slug}.`);
      },
    }),
    defineTool({
      name: "create_watch",
      label: "Create watch",
      description:
        "Schedule a watch: a crew member runs a prompt on a cron schedule or every N minutes, for the person you are talking with. The person approves this before it is created.",
      parameters: Type.Object({
        name: Type.String(),
        crew: Type.String({ description: "slug of the crew member who runs it" }),
        prompt: Type.String({ description: "what to do each run, with all needed context" }),
        cron: Type.Optional(Type.String({ description: 'cron expression, e.g. "0 7 * * 1-5"' })),
        timezone: Type.Optional(
          Type.String({ description: "IANA timezone, e.g. America/Chicago" }),
        ),
        everyMinutes: Type.Optional(Type.Number({ description: "instead of cron" })),
      }),
      async execute(_id, p) {
        if (!p.cron && !p.everyMinutes) throw new Error("give either cron or everyMinutes");
        const w = await host.createWatch(p);
        return text(`Created watch "${w.name}". It shows on the Watches page.`);
      },
    }),
    defineTool({
      name: "install_mcp_server",
      label: "Install MCP server",
      description:
        "Install a server from the MCP catalog and grant it to crew members. The person approves this first; servers that need keys still need an owner to enter them on the MCP page.",
      parameters: Type.Object({
        id: Type.String({ description: "catalog id, e.g. todoist, weather" }),
        crews: Type.Array(Type.String(), { description: "slugs of crew members to grant it to" }),
      }),
      async execute(_id, p) {
        requireManager();
        return text(await host.installMcp(p.id, p.crews));
      },
    }),
    defineTool({
      name: "delegate",
      label: "Delegate",
      description:
        "Hand a task to a crew member and get their reply. The person sees the hand-off and the crew member's answer in the conversation, so do not repeat it at length; add only what they need next.",
      promptSnippet: "delegate: hand a task to a crew member whose role fits",
      parameters: Type.Object({
        crew: Type.String({ description: "the crew member's slug" }),
        task: Type.String({
          description:
            "what to do, with all the context they need; they cannot see this conversation",
        }),
      }),
      executionMode: "sequential",
      async execute(_id, p, signal) {
        const reply = await host.delegate(p.crew, p.task, signal);
        return text(reply || "(no reply)");
      },
    }),
  ];
}

/** What a crew member's `ask_captain` tool needs: a short consult with the coordinator. */
export interface CrewHost {
  /** Ask the Captain `question` and return their answer. */
  askCaptain(question: string, signal: AbortSignal | undefined): Promise<string>;
}

/**
 * Tools every crew member except the Captain gets. Crew run on smaller models; when unsure they
 * check with the Captain, who runs on the strongest one, instead of guessing.
 */
export function crewTools(host: CrewHost, captainName: string): ToolDefinition[] {
  return [
    defineTool({
      name: "ask_captain",
      label: `Ask ${captainName}`,
      description: `Ask ${captainName}, the crew's coordinator, when you are unsure what the person wants, what to do next, or whether something is in your job, instead of guessing. ${captainName} cannot see your work, so include what you are doing, what you found or tried, and the options you see. Do not ask what you can check yourself.`,
      promptSnippet: `ask_captain: check with ${captainName} when unsure instead of guessing`,
      parameters: Type.Object({
        question: Type.String({
          description: "the question, with the context and options needed to answer it",
        }),
      }),
      executionMode: "sequential",
      async execute(_id, p, signal) {
        const answer = await host.askCaptain(p.question, signal);
        return text(answer || `(${captainName} gave no answer; use your best judgment and say so)`);
      },
    }),
  ];
}
