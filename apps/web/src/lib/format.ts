const intFmt = new Intl.NumberFormat("en-US");

export function formatTokens(n: number): string {
  return intFmt.format(n);
}

/** costMicroUsd → "$0.0123" (4 decimals). */
/** "$1,234.57", or "$0.0012" for amounts under a cent so tiny spend still shows. */
export function formatCost(micro: number): string {
  const usd = micro / 1_000_000;
  const digits = usd !== 0 && Math.abs(usd) < 0.01 ? 4 : 2;
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function formatCents(cents: number | null): string {
  if (cents === null) return "No cap";
  return `$${(cents / 100).toFixed(2)}`;
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "12.50" → 1250; "" → null; invalid → undefined. */
export function dollarsToCents(input: string): number | null | undefined {
  const t = input.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return undefined;
  return Math.round(Number.parseFloat(t) * 100);
}
