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
