import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  THEME_BUILD_GUIDE,
  THEME_CORNERS,
  THEME_FONTS,
  THEME_NEUTRALS,
  THEME_WORDS,
} from "@shipmate/core";
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
  /** What the model costs in a few words (e.g. "$1 in / $5 out per million tokens"). */
  price?: string | undefined;
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
  backend?: "pi" | "claude-code-cli" | undefined;
  /** Merged into the current `cli` settings. */
  cli?:
    | {
        model?: string | undefined;
        allowedTools?: string[] | undefined;
        permissionMode?: "dontAsk" | "acceptEdits" | "plan" | "bypassPermissions" | undefined;
      }
    | undefined;
  tools?: string[] | undefined;
  mcp?: string[] | undefined;
  skills?: string[] | undefined;
  approval?: "ask" | "auto" | { "never-for": string[] } | undefined;
  allow?: string[] | undefined;
  autoApproveSkills?: boolean | undefined;
  helpers?: boolean | undefined;
  monthlyCapUsd?: number | null | undefined;
  visibility?: "shared" | "private" | undefined;
  avatar?: string | undefined;
  persona?: string | undefined;
}

/** Changes to one person's settings; profile fields are the household profile. */
export interface PersonChanges {
  displayName?: string | undefined;
  /** USD per month; null removes the cap. */
  monthlyCapUsd?: number | null | undefined;
  themeMode?: string | undefined;
  colorTheme?: string | undefined;
  diet?: string | undefined;
  budget?: string | undefined;
  timezone?: string | undefined;
  schedule?: string | undefined;
  notes?: string | undefined;
  /** Let crew working for other people read this profile. */
  shared?: boolean | undefined;
}

export interface HouseholdChanges {
  location?: string | undefined;
  timezone?: string | undefined;
  notes?: string | undefined;
}

/**
 * What the Captain's tools need from the server: the roster, recruiting, and running a task in
 * another crew member's session within the same conversation.
 */
export interface CaptainHost {
  listCrew(): Promise<CrewSummary[]>;
  /** Models crew can run on right now, cheapest first, one per line with its price. */
  listModels(): Promise<string>;
  recruit(spec: RecruitSpec): Promise<CrewSummary>;
  edit(slug: string, spec: EditSpec): Promise<CrewSummary>;
  /** A crew member's crew.yaml as text. */
  crewSettings(slug: string): Promise<string>;
  /** Everyone with an account, with their settings and profile (as far as `user` may see). */
  listPeople(): Promise<string>;
  /** Change one person's settings; `person` is a name, email or id. Returns a summary. */
  updatePerson(person: string, changes: PersonChanges): Promise<string>;
  updateHousehold(changes: HouseholdChanges): Promise<string>;
  retire(slug: string): Promise<void>;
  /** Put a crew member awaiting review to work (only after the person approves the call). */
  approve(slug: string): Promise<CrewSummary>;
  /** Run `task` with crew member `slug` and return its final reply. */
  delegate(slug: string, task: string, signal: AbortSignal | undefined): Promise<string>;
  /** Schedule a watch (routine) owned by the person in this conversation. */
  createWatch(spec: WatchSpec): Promise<{ id: string; name: string }>;
  /** Install a server from the MCP catalog and give it to crew members. */
  installMcp(id: string, crews: string[]): Promise<string>;
  /**
   * Add access to a crew member (the person approved it on a card first): MCP servers (installed
   * from the catalog when needed), built-in tools, skills and Claude Code tools. Returns a summary.
   */
  equip(slug: string, grant: EquipSpec): Promise<string>;
}

/** What equip_crew_member adds; each list is added to what the crew member already has. */
export interface EquipSpec {
  mcp?: string[] | undefined;
  tools?: string[] | undefined;
  skills?: string[] | undefined;
  claudeCodeTools?: string[] | undefined;
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
          `- ${c.slug}: ${c.name}, ${c.role} (model ${c.model}${c.price ? `, ${c.price}` : ""}${c.status === "pending_review" ? ", awaiting review" : ""}${c.captain ? ", you" : ""})`,
      )
      .join("\n");
  const stringList = (description: string) =>
    Type.Optional(Type.Array(Type.String(), { description }));

  return [
    defineTool({
      name: "list_crew",
      label: "List crew",
      description: "List the crew members aboard, with their roles, models and what those cost.",
      parameters: Type.Object({}),
      async execute() {
        return text(roster(await host.listCrew()) || "No crew yet.");
      },
    }),
    defineTool({
      name: "list_models",
      label: "List models",
      description:
        "List the models crew members can run on, cheapest first, with prices. Use it to pick the smallest model that does a crew member's job (for recruit_crew_member or edit_crew_member).",
      promptSnippet: "list_models: the models crew can run on, cheapest first",
      parameters: Type.Object({}),
      async execute() {
        return text((await host.listModels()) || "No models are set up yet.");
      },
    }),
    defineTool({
      name: "recruit_crew_member",
      label: "Recruit crew member",
      description:
        "Create a new specialist crew member for a recurring kind of work. It starts awaiting review; put it to work with approve_crew_member, which asks the person first.",
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
          `Recruited ${c.name} (${c.slug}); they are awaiting review. Tell ${user.displayName} who they are and what they will do, then call approve_crew_member so ${user.displayName} can approve them here.`,
        );
      },
    }),
    defineTool({
      name: "crew_settings",
      label: "Crew settings",
      description:
        "Read a crew member's settings (their crew.yaml): model, backend, tools, MCP servers, skills, approvals, spending cap and visibility.",
      parameters: Type.Object({ slug: Type.String() }),
      async execute(_id, p) {
        return text(await host.crewSettings(p.slug));
      },
    }),
    defineTool({
      name: "edit_crew_member",
      label: "Edit crew member",
      description:
        "Change any of a crew member's settings: name, role, model, backend, Claude Code options, helper agents, tools, MCP servers, skills, approvals, spending cap, visibility, or persona (replaces CREW.md entirely when given). Only the fields you pass change; read crew_settings first.",
      promptSnippet: "edit_crew_member: change any crew member setting (read crew_settings first)",
      parameters: Type.Object({
        slug: Type.String(),
        name: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
        model: Type.Optional(Type.String({ description: "provider/model" })),
        backend: Type.Optional(
          Type.Union([Type.Literal("pi"), Type.Literal("claude-code-cli")], {
            description:
              '"pi" (Shipmate with the instance providers) or "claude-code-cli" (an owner\'s own Claude subscription)',
          }),
        ),
        cliModel: Type.Optional(
          Type.String({ description: "claude-code-cli only: alias such as sonnet or opus" }),
        ),
        cliAllowedTools: stringList("claude-code-cli only: tools it may use, e.g. Read, Edit"),
        cliPermissionMode: Type.Optional(
          Type.Union(
            [
              Type.Literal("dontAsk"),
              Type.Literal("acceptEdits"),
              Type.Literal("plan"),
              Type.Literal("bypassPermissions"),
            ],
            { description: "bypassPermissions allows every tool; only when the person asks" },
          ),
        ),
        tools: stringList("replaces the built-in tool list; empty means all built-in tools"),
        mcp: stringList("replaces the MCP server list"),
        skills: stringList("replaces the skill list"),
        approval: Type.Optional(
          Type.Union([Type.Literal("ask"), Type.Literal("auto"), Type.Literal("never-for")], {
            description:
              '"ask" before consequential tools, "auto" never asks, "never-for" blocks the tools in neverFor and runs the rest',
          }),
        ),
        neverFor: stringList('tools that are never run, with approval "never-for"'),
        allow: stringList("replaces the tools it may run without asking"),
        autoApproveSkills: Type.Optional(Type.Boolean()),
        helpers: Type.Optional(
          Type.Boolean({ description: "let it start helper agents for parts of a task" }),
        ),
        monthlyCapUsd: Type.Optional(
          Type.Number({ description: "monthly spend ceiling in USD; 0 removes the cap" }),
        ),
        visibility: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("private")])),
        persona: Type.Optional(Type.String()),
      }),
      async execute(_id, p) {
        requireManager();
        const { slug, cliModel, cliAllowedTools, cliPermissionMode, approval, neverFor, ...rest } =
          p;
        if (approval === "never-for" && !neverFor?.length) {
          throw new Error('approval "never-for" needs at least one tool in neverFor');
        }
        const spec: EditSpec = {
          ...rest,
          ...(rest.monthlyCapUsd !== undefined
            ? { monthlyCapUsd: rest.monthlyCapUsd > 0 ? rest.monthlyCapUsd : null }
            : {}),
          ...(cliModel !== undefined || cliAllowedTools || cliPermissionMode
            ? {
                cli: {
                  ...(cliModel !== undefined ? { model: cliModel } : {}),
                  ...(cliAllowedTools ? { allowedTools: cliAllowedTools } : {}),
                  ...(cliPermissionMode ? { permissionMode: cliPermissionMode } : {}),
                },
              }
            : {}),
          ...(approval
            ? { approval: approval === "never-for" ? { "never-for": neverFor ?? [] } : approval }
            : {}),
        };
        const c = await host.edit(slug, spec);
        return text(`Updated ${c.name}.`);
      },
    }),
    defineTool({
      name: "approve_crew_member",
      label: "Approve crew member",
      description:
        "Put a crew member who is awaiting review (one you recruited, or one imported from a file) to work. The person you are talking with always approves this on a card first. Read their persona and crew_settings beforehand and fix anything unsafe.",
      promptSnippet: "approve_crew_member: ask the person to approve a new crew member",
      parameters: Type.Object({ slug: Type.String() }),
      async execute(_id, p) {
        requireManager();
        const c = await host.approve(p.slug);
        return text(`${c.name} is approved and ready for work.`);
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
      name: "equip_crew_member",
      label: "Equip crew member",
      description:
        "Give a crew member what they need for their job: MCP servers (installed from the catalog if needed), built-in tools, skills, and for crew on Claude Code the Claude Code tools they may use. Adds to what they have. The person approves it on a card first, so give a short reason. Use crew_settings first to see what they have.",
      promptSnippet:
        "equip_crew_member: give a crew member servers, tools or skills (the person approves)",
      parameters: Type.Object({
        slug: Type.String(),
        reason: Type.String({
          description: "one short line the person reads on the card: why they need it",
        }),
        mcp: stringList("MCP server ids to add, e.g. github, fetch, web-search"),
        tools: stringList("built-in tools to add, e.g. read, bash"),
        skills: stringList("skills to add"),
        claudeCodeTools: stringList(
          "claude-code-cli only: tools to allow without asking, e.g. Read, Edit, Bash, WebFetch",
        ),
      }),
      async execute(_id, { slug, reason: _reason, ...grant }) {
        requireManager();
        if (!Object.values(grant).some((list) => list?.length)) {
          throw new Error("name at least one thing to add");
        }
        return text(await host.equip(slug, grant));
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
      name: "list_people",
      label: "List people",
      description:
        "List everyone with an account on this instance, with their role, spending cap, appearance and household profile (diet, budget, timezone, schedule, notes). Use it before setting people up.",
      parameters: Type.Object({}),
      async execute() {
        return text(await host.listPeople());
      },
    }),
    defineTool({
      name: "update_person",
      label: "Update person",
      description:
        "Set up or change one person's settings: display name, monthly spending cap, theme, and their household profile (diet, budget, timezone, schedule, notes, and whether crew helping others may read it). Anyone can change their own; owners and admins can set up others (the name and cap of others: owner only). Only the fields you pass change.",
      promptSnippet: "update_person: set up someone's profile and settings",
      parameters: Type.Object({
        person: Type.String({ description: 'their name, email or id; or "me"' }),
        displayName: Type.Optional(Type.String()),
        monthlyCapUsd: Type.Optional(
          Type.Number({ description: "monthly spending cap in USD; 0 removes the cap" }),
        ),
        themeMode: Type.Optional(
          Type.Union([Type.Literal("auto"), Type.Literal("light"), Type.Literal("dark")]),
        ),
        colorTheme: Type.Optional(
          Type.String({
            description: "harbor, open-sea, coral-reef, kelp-forest, lighthouse or admiral",
          }),
        ),
        diet: Type.Optional(Type.String()),
        budget: Type.Optional(Type.String()),
        timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. Europe/Berlin" })),
        schedule: Type.Optional(Type.String()),
        notes: Type.Optional(Type.String()),
        shared: Type.Optional(
          Type.Boolean({ description: "let crew working for others read this profile" }),
        ),
      }),
      async execute(_id, { person, ...changes }) {
        const target = person.trim().toLowerCase() === "me" ? user.id : person;
        return text(
          await host.updatePerson(target, {
            ...changes,
            ...(changes.monthlyCapUsd !== undefined
              ? { monthlyCapUsd: changes.monthlyCapUsd > 0 ? changes.monthlyCapUsd : null }
              : {}),
          }),
        );
      },
    }),
    defineTool({
      name: "update_household",
      label: "Update household",
      description:
        "Set the household facts every crew member sees: home location, household timezone and notes (who lives here, kids, routines). Owners and admins only; only the fields you pass change.",
      parameters: Type.Object({
        location: Type.Optional(Type.String({ description: "town or city, for weather" })),
        timezone: Type.Optional(Type.String({ description: "IANA timezone" })),
        notes: Type.Optional(Type.String()),
      }),
      async execute(_id, p) {
        requireManager();
        return text(await host.updateHousehold(p));
      },
    }),
    defineTool({
      name: "delegate",
      label: "Delegate",
      description:
        "Hand a task to a crew member and get their reply. Prefer this to doing the work yourself whenever a crew member's role fits: they run on their own, usually cheaper, model and keep tool output out of your context. They remember earlier tasks in this conversation, so to correct their work, delegate to them again with specific notes. The person sees the hand-off and the crew member's answer, so do not repeat it at length; add only what they need next.",
      promptSnippet:
        "delegate: hand work to the crew member whose role fits (the default for anything beyond a quick answer)",
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
        return text(
          reply
            ? `${reply}\n\n(Check this against what was asked. If it misses, delegate to ${p.crew} again with specific notes instead of redoing the work yourself.)`
            : `(no reply) Ask ${p.crew} again with clearer instructions, or tell the person it did not work.`,
        );
      },
    }),
  ];
}

/** What `ask_person` needs: show the question with answer buttons and wait for the answer. */
export interface QuestionHost {
  /** The person's answer, or null when they skip it or do not answer in time. */
  ask(
    question: { text: string; options: Array<{ label: string; detail?: string }> },
    signal: AbortSignal | undefined,
  ): Promise<string | null>;
}

/**
 * Every crew member can ask the person a question with tap-to-answer choices, like the
 * question cards in ChatGPT and Claude, and carry on with the answer in the same turn.
 */
export function questionTools(host: QuestionHost, personName: string): ToolDefinition[] {
  return [
    defineTool({
      name: "ask_person",
      label: `Ask ${personName}`,
      description: `Ask ${personName} a question they answer by tapping a choice, when you need their decision or a missing detail to carry on: which option, which time, which project. Give 2 to 6 short choices; they can also type their own answer or skip. You wait for the answer and continue in this turn. Ask one question at a time, only when you cannot reasonably decide yourself.`,
      promptSnippet: `ask_person: ask ${personName} a question with tap-to-answer choices`,
      parameters: Type.Object({
        question: Type.String({ description: "one short question" }),
        options: Type.Array(
          Type.Object({
            label: Type.String({ description: "the answer as a few words, e.g. Saturday 10am" }),
            detail: Type.Optional(
              Type.String({ description: "a short line under it, when the label needs it" }),
            ),
          }),
          { minItems: 2, maxItems: 6 },
        ),
      }),
      executionMode: "sequential",
      async execute(_id, p, signal) {
        const options = p.options
          .map((o) => ({
            label: o.label.trim().slice(0, 80),
            ...(o.detail?.trim() ? { detail: o.detail.trim().slice(0, 200) } : {}),
          }))
          .filter((o) => o.label);
        if (options.length < 2) throw new Error("give at least two choices");
        const answer = await host.ask(
          { text: p.question.trim().slice(0, 500), options: options.slice(0, 6) },
          signal,
        );
        return text(
          answer === null
            ? `${personName} skipped the question or did not answer. Use your best judgment, and say what you assumed.`
            : `${personName} answered: ${answer}`,
        );
      },
    }),
  ];
}

/** What the `helper` tool needs: run one task in a fresh copy of the crew member. */
export interface HelperHost {
  /** Run `task` in a new helper session and return its final reply. */
  run(task: string, signal: AbortSignal | undefined): Promise<string>;
}

/** The `helper` tool, for crew members with `helpers: true` in crew.yaml. */
export function helperTools(host: HelperHost): ToolDefinition[] {
  return [
    defineTool({
      name: "helper",
      label: "Helper agent",
      description:
        "Start a helper agent: a fresh copy of you, with your tools, that works on one task and returns its answer. Use it for parts of a bigger job that can run on their own, such as researching several things at once or checking separate files; call it several times in one go to run helpers side by side. Helpers cannot see this conversation, ask the person anything, or start helpers of their own, so give each one the whole task and the context it needs.",
      promptSnippet: "helper: hand part of a task to a helper agent; several run side by side",
      parameters: Type.Object({
        task: Type.String({
          description: "what to do and what to report back, with all the context it needs",
        }),
      }),
      executionMode: "parallel",
      async execute(_id, p, signal) {
        const reply = await host.run(p.task, signal);
        return text(reply || "(the helper gave no answer)");
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

/** What the theme tools need: the instance's themes and the person's own pick. */
export interface ThemeHost {
  /** One line per saved theme, with ids. */
  list(): Promise<string>;
  /**
   * Check and save a theme (replacing `id` when given), show its preview card in the
   * conversation, and say what happened. Throws with every problem when the theme needs fixing.
   */
  save(theme: Record<string, unknown>, id: string | undefined): Promise<string>;
  /** Switch the person to a theme, or back to the standard look with null. */
  use(id: string | null): Promise<string>;
}

/**
 * Building custom themes with the person (Settings > Appearance > Make a custom theme opens a
 * chat for it). The Captain reads the build guide and follows it step by step.
 */
export function themeTools(host: ThemeHost): ToolDefinition[] {
  return [
    defineTool({
      name: "theme_build_guide",
      label: "Theme build guide",
      description:
        "Read this first whenever someone wants a custom theme (new look, logo, names or voice for the app). It gives the steps to follow, one by one.",
      promptSnippet: "theme_build_guide: read this before building a custom theme with someone",
      parameters: Type.Object({}),
      async execute() {
        return text(THEME_BUILD_GUIDE);
      },
    }),
    defineTool({
      name: "list_themes",
      label: "List themes",
      description: "List the custom themes saved on this Shipmate, with their ids.",
      parameters: Type.Object({}),
      async execute() {
        return text(await host.list());
      },
    }),
    defineTool({
      name: "save_theme",
      label: "Save theme",
      description:
        "Save a custom theme (step 8 of theme_build_guide) and show the person a preview card with a Try it button. It always saves: anything it cannot use is fixed or left out, and it tells you what. To change a saved theme, pass its id and the full theme again.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "only when changing a saved theme" })),
        name: Type.Optional(Type.String({ description: "the theme's name, 1 to 4 words" })),
        description: Type.Optional(Type.String({ description: "one short line about it" })),
        accent: Type.Optional(Type.String({ description: "the main color as hex, like #dc2626" })),
        neutral: Type.Optional(
          Type.String({ description: `one of: ${THEME_NEUTRALS.join(", ")}` }),
        ),
        font: Type.Optional(Type.String({ description: `one of: ${THEME_FONTS.join(", ")}` })),
        corners: Type.Optional(Type.String({ description: `one of: ${THEME_CORNERS.join(", ")}` })),
        logo: Type.Optional(
          Type.String({
            description: 'an SVG icon: <svg viewBox="0 0 64 64" fill="currentColor">...</svg>',
          }),
        ),
        words: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: `names for: ${Object.keys(THEME_WORDS).join(", ")}`,
          }),
        ),
        voice: Type.Optional(
          Type.String({ description: "2 to 4 sentences on how the AI helpers talk in this theme" }),
        ),
      }),
      executionMode: "sequential",
      async execute(_id, { id, ...theme }) {
        return text(await host.save(theme, id?.trim() || undefined));
      },
    }),
    defineTool({
      name: "use_theme",
      label: "Use theme",
      description:
        'Switch the person you are talking with to a saved custom theme, or back to the standard Shipmate look with "default". Only for their own appearance.',
      parameters: Type.Object({
        id: Type.String({ description: 'a theme id from list_themes, or "default"' }),
      }),
      async execute(_id, p) {
        const id = p.id.trim();
        return text(await host.use(id === "default" || !id ? null : id));
      },
    }),
  ];
}
