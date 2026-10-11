import type { ListDetailDto, ListKind } from "@shipmate/core";

export const LIST_KINDS: Array<{ id: ListKind; label: string; placeholder: string }> = [
  { id: "grocery", label: "Groceries", placeholder: "e.g. 2 onions" },
  { id: "todo", label: "To-do", placeholder: "e.g. Call the plumber" },
  { id: "packing", label: "Packing", placeholder: "e.g. Passport" },
  { id: "bills", label: "Bills", placeholder: "e.g. Electricity, $84" },
  { id: "other", label: "Other", placeholder: "Add an item" },
];

export function kindLabel(kind: ListKind): string {
  return LIST_KINDS.find((k) => k.id === kind)?.label ?? "Other";
}

export function itemPlaceholder(kind: ListKind): string {
  return LIST_KINDS.find((k) => k.id === kind)?.placeholder ?? "Add an item";
}

/** Today in the browser's timezone as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole days from `today` to `dueOn` (both YYYY-MM-DD); negative when overdue. */
export function daysUntil(dueOn: string, today: string): number {
  const a = Date.UTC(...ymd(today));
  const b = Date.UTC(...ymd(dueOn));
  return Math.round((b - a) / 86_400_000);
}

function ymd(s: string): [number, number, number] {
  const [y, m, d] = s.split("-").map(Number);
  return [y ?? 1970, (m ?? 1) - 1, d ?? 1];
}

/** "Due today", "Due tomorrow", "Due in 3 days", "Overdue by 2 days", "Due Oct 31". */
export function dueLabel(
  dueOn: string,
  today: string,
): { text: string; tone: "danger" | "warn" | "neutral" } {
  const n = daysUntil(dueOn, today);
  if (n < 0) return { text: `Overdue by ${-n} day${n === -1 ? "" : "s"}`, tone: "danger" };
  if (n === 0) return { text: "Due today", tone: "warn" };
  if (n === 1) return { text: "Due tomorrow", tone: "warn" };
  if (n <= 7) return { text: `Due in ${n} days`, tone: "neutral" };
  const d = new Date(`${dueOn}T12:00:00Z`);
  return {
    text: `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
    tone: "neutral",
  };
}

/** The list as it will look once an item is (un)checked, so the checkbox responds at once. */
export function withItemChecked(
  list: ListDetailDto,
  itemId: string,
  checked: boolean,
): ListDetailDto {
  const items = list.items.map((i) => (i.id === itemId ? { ...i, checked } : i));
  return { ...list, items, openCount: items.filter((i) => !i.checked).length };
}

/**
 * Keeps the list from flickering back while quick changes are in flight: an answer from the
 * server (or a refetch after a live update) can predate a change made after it, and showing it
 * would undo that change on screen. Only the change that finishes last shows its answer, and live
 * updates that arrive meanwhile are fetched once everything has settled.
 */
export class PendingChanges {
  #pending = 0;
  #stale = false;

  start(): void {
    this.#pending++;
  }

  /** One change finished (`ok` false when it failed): show its answer, refetch, or both. */
  finish(ok: boolean): { show: boolean; reload: boolean } {
    this.#pending = Math.max(0, this.#pending - 1);
    if (!ok) this.#stale = true;
    const last = this.#pending === 0;
    const reload = last && this.#stale;
    if (last) this.#stale = false;
    return { show: last && ok, reload };
  }

  /** Something changed elsewhere; true when it is safe to refetch now. */
  changedElsewhere(): boolean {
    if (this.#pending > 0) {
      this.#stale = true;
      return false;
    }
    return true;
  }
}
