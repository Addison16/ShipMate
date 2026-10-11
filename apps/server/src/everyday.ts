import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ListDetailDto, ListDto, ListKind } from "@shipmate/core";
import { type CrewFolder, type ListHost, type ListSummary, listTools } from "@shipmate/crew";
import type { UserRow } from "./auth.js";
import type { ListService } from "./services/lists.js";

/**
 * Everyday-life tools every crew member gets (shared lists, ...), bound to the person the crew
 * member is working for. The Bridge asks for them when it opens a session.
 */
export class EverydayTools {
  constructor(private readonly deps: { lists: ListService }) {}

  tools(user: UserRow, crew: CrewFolder): ToolDefinition[] {
    return [...listTools(this.#listHost(user, crew))];
  }

  #listHost(user: UserRow, crew: CrewFolder): ListHost {
    const lists = this.deps.lists;
    const actor = { user, crew: { slug: crew.slug, name: crew.manifest.name } };
    return {
      lists: async () => (await lists.list(user)).map(summary),
      read: async (ref) => {
        const l = await lists.find(user, ref);
        return { list: summary(l), items: l.items };
      },
      create: async (input) =>
        summary(
          await lists.create(actor, {
            name: input.name,
            kind: input.kind as ListKind,
            shared: !input.private,
          }),
        ),
      add: async (ref, items) => {
        const l = await lists.find(user, ref);
        const r = await lists.addItems(actor, l.id, items);
        return { list: summary(r.list), added: r.added, skipped: r.skipped };
      },
      change: async (ref, names, change) => {
        const l = await lists.find(user, ref);
        const r = await lists.changeByText(actor, l.id, names, change);
        return { list: summary(r.list), changed: r.changed, missing: r.missing };
      },
    };
  }
}

const summary = (l: ListDto | ListDetailDto): ListSummary => ({
  id: l.id,
  name: l.name,
  kind: l.kind,
  shared: l.shared,
  open: l.openCount,
  total: l.itemCount,
});
