const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A simple cron schedule in words: "Sundays at 17:00", "Weekdays at 07:00", "Every day at 21:00",
 * "Sunday to Thursday at 20:00". Anything fancier comes back as "Cron <expression>".
 */
export function describeSchedule(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  const fallback = `Cron ${expression.trim()}`;
  if (parts.length !== 5) return fallback;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== "*" || month !== "*") {
    return fallback;
  }
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return fallback;
  const at = `at ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dow === "*") return `Every day ${at}`;
  if (dow === "1-5") return `Weekdays ${at}`;
  if (dow === "0,6" || dow === "6,0") return `Weekends ${at}`;
  const day = (d: string) => DAYS[Number(d) % 7];
  if (/^[0-7]$/.test(dow)) return `${day(dow)}s ${at}`;
  const range = /^([0-7])-([0-7])$/.exec(dow);
  if (range?.[1] && range[2]) return `${day(range[1])} to ${day(range[2])} ${at}`;
  return fallback;
}

/** The browser's IANA timezone, for schedules; undefined when the browser does not say. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
