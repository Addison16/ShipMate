import type { ListKind } from "@shipmate/core";

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
