import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

// ---------- shared lists ----------

export interface ListSummary {
  id: string;
  name: string;
  kind: string;
  shared: boolean;
  open: number;
  total: number;
}

export interface ListItemSummary {
  text: string;
  checked: boolean;
  dueOn: string | null;
  note: string | null;
}

/**
 * What the list tools need from the server, already bound to the person the crew member is
 * working for: lists are looked up by name (or id) among the lists that person can see.
 */
export interface ListHost {
  lists(): Promise<ListSummary[]>;
  read(list: string): Promise<{ list: ListSummary; items: ListItemSummary[] }>;
  create(input: { name: string; kind: string; private: boolean }): Promise<ListSummary>;
  add(
    list: string,
    items: Array<{ text: string; dueOn?: string | undefined; note?: string | undefined }>,
  ): Promise<{ list: ListSummary; added: string[]; skipped: string[] }>;
  change(
    list: string,
    items: string[],
    change: { checked: boolean } | "remove",
  ): Promise<{ list: ListSummary; changed: string[]; missing: string[] }>;
}

const KINDS = ["grocery", "todo", "packing", "bills", "other"] as const;

const describeList = (l: ListSummary) =>
  `${l.name} (${l.kind}, ${l.shared ? "shared" : "private"}): ${l.open} open of ${l.total}`;

export function formatItems(items: ListItemSummary[], includeChecked: boolean): string {
  const shown = includeChecked ? items : items.filter((i) => !i.checked);
  if (!shown.length) return includeChecked ? "(empty)" : "(nothing open)";
  return shown
    .map((i) => {
      const due = i.dueOn ? ` (due ${i.dueOn})` : "";
      const note = i.note ? ` — ${i.note}` : "";
      return `- [${i.checked ? "x" : " "}] ${i.text}${due}${note}`;
    })
    .join("\n");
}

/**
 * Lists the household keeps with the crew: groceries, to-dos, packing, bills. They are real
 * objects with their own page and checkboxes, so crew keep them here instead of in memory.
 */
export function listTools(host: ListHost): ToolDefinition[] {
  const listParam = Type.String({ description: 'the list\'s name, e.g. "Groceries"' });
  const itemNames = Type.Array(Type.String(), {
    description: "item texts as they appear on the list (a unique part of the text is enough)",
  });
  return [
    defineTool({
      name: "show_lists",
      label: "Show lists",
      description:
        "Show the household's shared lists and the person's private lists (groceries, to-dos, packing, bills) with how many items are still open.",
      promptSnippet:
        "show_lists / read_list / add_to_list / check_list_items: the household's lists",
      parameters: Type.Object({}),
      async execute() {
        const all = await host.lists();
        return text(
          all.length ? all.map((l) => `- ${describeList(l)}`).join("\n") : "No lists yet.",
        );
      },
    }),
    defineTool({
      name: "read_list",
      label: "Read list",
      description: "Read the items on a list. Checked-off items are left out unless asked for.",
      parameters: Type.Object({
        list: listParam,
        includeChecked: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, p) {
        const { list, items } = await host.read(p.list);
        return text(`${describeList(list)}\n${formatItems(items, p.includeChecked ?? false)}`);
      },
    }),
    defineTool({
      name: "create_list",
      label: "Create list",
      description:
        "Create a list. Shared lists are for everyone in the household; private ones only for the person you are helping (use private for anything personal, like health).",
      parameters: Type.Object({
        name: Type.String(),
        kind: Type.Union(
          KINDS.map((k) => Type.Literal(k)),
          { description: "grocery, todo, packing, bills or other" },
        ),
        private: Type.Optional(Type.Boolean({ description: "default false (shared)" })),
      }),
      async execute(_id, p) {
        const l = await host.create({ name: p.name, kind: p.kind, private: p.private ?? false });
        return text(`Created ${describeList(l)}.`);
      },
    }),
    defineTool({
      name: "add_to_list",
      label: "Add to list",
      description:
        "Add items to a list, one thing per item. Items already open on the list are not added twice.",
      parameters: Type.Object({
        list: listParam,
        items: Type.Array(
          Type.Object({
            text: Type.String({ description: 'e.g. "2 onions"' }),
            dueOn: Type.Optional(
              Type.String({ description: "YYYY-MM-DD, e.g. a bill's due date" }),
            ),
            note: Type.Optional(Type.String()),
          }),
        ),
      }),
      async execute(_id, p) {
        const r = await host.add(p.list, p.items);
        const parts = [`${r.list.name}: added ${r.added.length ? r.added.join(", ") : "nothing"}.`];
        if (r.skipped.length) parts.push(`Already on the list: ${r.skipped.join(", ")}.`);
        return text(parts.join(" "));
      },
    }),
    defineTool({
      name: "check_list_items",
      label: "Check off",
      description:
        "Check items off a list (bought, done, packed, paid), or uncheck them with checked: false.",
      parameters: Type.Object({
        list: listParam,
        items: itemNames,
        checked: Type.Optional(Type.Boolean({ description: "default true" })),
      }),
      async execute(_id, p) {
        const checked = p.checked ?? true;
        const r = await host.change(p.list, p.items, { checked });
        return text(changeSummary(r, checked ? "Checked off" : "Unchecked"));
      },
    }),
    defineTool({
      name: "remove_from_list",
      label: "Remove from list",
      description: "Remove items from a list entirely (added by mistake, no longer wanted).",
      parameters: Type.Object({ list: listParam, items: itemNames }),
      async execute(_id, p) {
        const r = await host.change(p.list, p.items, "remove");
        return text(changeSummary(r, "Removed"));
      },
    }),
  ];
}

function changeSummary(
  r: { list: ListSummary; changed: string[]; missing: string[] },
  verb: string,
): string {
  const parts = [`${r.list.name}: ${verb.toLowerCase()} ${r.changed.join(", ") || "nothing"}.`];
  if (r.missing.length) {
    parts.push(`Not found or ambiguous: ${r.missing.join(", ")}. Read the list for exact names.`);
  }
  return parts.join(" ");
}

// ---------- household profiles ----------

/** The household facts and the profiles the crew may read, already formatted. */
export interface ProfileHost {
  read(): Promise<string>;
}

export function profileTools(host: ProfileHost): ToolDefinition[] {
  return [
    defineTool({
      name: "read_profiles",
      label: "Read profiles",
      description:
        "Read the household profile in full: household facts (home, kids, routines), the diet, budget, timezone and schedule of the person you are helping, and the profiles others in the household chose to share. Use it before planning for more than one person.",
      parameters: Type.Object({}),
      async execute() {
        return text(await host.read());
      },
    }),
  ];
}

// ---------- weather and the daily briefing ----------

/** Forecasts by place name; the server knows the household's home location. */
export interface WeatherHost {
  /** Formatted forecast; `place` defaults to the household's home location. */
  forecast(place: string | undefined, days: number): Promise<string>;
}

export function weatherTools(host: WeatherHost): ToolDefinition[] {
  return [
    defineTool({
      name: "get_weather",
      label: "Weather",
      description:
        "Current weather and the daily forecast (Open-Meteo) for a place. Leave out the place for the household's home location.",
      promptSnippet: "get_weather: forecast for a place (default: home)",
      parameters: Type.Object({
        place: Type.Optional(
          Type.String({ description: 'town and region or country, e.g. "Austin, TX"' }),
        ),
        days: Type.Optional(Type.Number({ description: "1 to 7, default 3" })),
      }),
      async execute(_id, p) {
        return text(await host.forecast(p.place, p.days ?? 3));
      },
    }),
  ];
}

/** What happened lately and what is coming up, for the person the crew member works for. */
export interface BriefingHost {
  /** Watch runs, crew replies, crew actions and list changes in the last `hours`. */
  recentActivity(hours: number): Promise<string>;
  /** Unchecked list items (bills, to-dos) due within `days` days, overdue ones included. */
  dueSoon(days: number): Promise<string>;
}

export function briefingTools(host: BriefingHost): ToolDefinition[] {
  return [
    defineTool({
      name: "recent_activity",
      label: "Recent activity",
      description:
        "What the crew did lately for the person you are helping: watch runs and their results, conversations the crew answered, actions taken or refused, and list changes. Use it for briefings and catch-ups.",
      parameters: Type.Object({
        hours: Type.Optional(Type.Number({ description: "how far back, default 12" })),
      }),
      async execute(_id, p) {
        return text(await host.recentActivity(Math.min(24 * 14, Math.max(1, p.hours ?? 12))));
      },
    }),
    defineTool({
      name: "due_soon",
      label: "Due soon",
      description:
        "Bills, to-dos and other list items that are not done and are due soon or overdue, across every list you can see.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "look this many days ahead, default 7" })),
      }),
      async execute(_id, p) {
        return text(await host.dueSoon(Math.min(90, Math.max(0, p.days ?? 7))));
      },
    }),
  ];
}
