/** A file-safe name for a new memory, from what it says: "Sam is vegetarian" → "sam-is-vegetarian". */
export function memoryName(description: string, taken: string[] = []): string {
  const base =
    description
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "note";
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}
