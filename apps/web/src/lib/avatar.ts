/** Colors for crew avatars, picked by name so each crew member keeps theirs everywhere. */
export const AVATAR_TONES = [
  "bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-sky-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-500/25 dark:text-rose-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-500/25 dark:text-amber-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-500/25 dark:text-orange-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-500/25 dark:text-cyan-200",
  "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-500/25 dark:text-fuchsia-200",
] as const;

export function avatarTone(name: string): string {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length] as string;
}

/** One or two letters: "Captain" → "C", "Kelp Forest" → "KF". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]] : [words[0]];
  return letters
    .map((w) => (w ? Array.from(w)[0] : ""))
    .join("")
    .toUpperCase();
}
