import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CREW_FILES, MEMORY_INDEX, MemoryFrontmatter } from "@shipmate/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type MemoryScope = "shared" | "user";

export interface MemoryEntry extends MemoryFrontmatter {
  body: string;
  scope: MemoryScope;
  updatedAt: Date;
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Crew memory on disk, one fact per file, in the same shape Claude's memory uses:
 *
 *   memory/shared/MEMORY.md, memory/shared/<name>.md          everyone on this instance
 *   memory/users/<userId>/MEMORY.md, .../<name>.md           one person only
 *
 * The index files are regenerated on every write so a person can also edit facts by hand.
 */
export class MemoryStore {
  constructor(readonly crewDir: string) {}

  dir(scope: MemoryScope, userId?: string): string {
    const root = join(this.crewDir, CREW_FILES.memoryDir);
    if (scope === "shared") return join(root, "shared");
    if (!userId || !USER_ID.test(userId)) throw new Error("user memory needs a valid user id");
    return join(root, "users", userId);
  }

  list(scope: MemoryScope, userId?: string): MemoryEntry[] {
    const dir = this.dir(scope, userId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== MEMORY_INDEX)
      .map((f) => this.#read(join(dir, f), scope))
      .filter((e): e is MemoryEntry => e !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  write(
    scope: MemoryScope,
    userId: string | undefined,
    input: { name: string; description: string; type?: MemoryFrontmatter["type"]; body: string },
  ): MemoryEntry {
    const fm = MemoryFrontmatter.parse({
      name: input.name,
      description: input.description,
      type: input.type,
    });
    const dir = this.dir(scope, userId);
    mkdirSync(dir, { recursive: true });
    const text = `---\n${stringifyYaml(fm)}---\n\n${input.body.trim()}\n`;
    writeFileSync(join(dir, `${fm.name}.md`), text);
    this.#reindex(scope, userId);
    return { ...fm, body: input.body.trim(), scope, updatedAt: new Date() };
  }

  remove(scope: MemoryScope, userId: string | undefined, name: string): boolean {
    const parsed = MemoryFrontmatter.shape.name.safeParse(name);
    if (!parsed.success) return false;
    const file = join(this.dir(scope, userId), `${name}.md`);
    if (!existsSync(file)) return false;
    rmSync(file);
    this.#reindex(scope, userId);
    return true;
  }

  /**
   * The memory a crew member sees at the start of a conversation with this person: the shared
   * index and their own index. Bodies are fetched with the `recall` tool when relevant.
   */
  contextFor(userId: string): string {
    const lines = (entries: MemoryEntry[]) =>
      entries.length
        ? entries.map((e) => `- [${e.name}] (${e.type}) ${e.description}`).join("\n")
        : "(nothing yet)";
    return [
      "## Your memory",
      "",
      "Shared with everyone on this instance:",
      lines(this.list("shared")),
      "",
      "Private to the person you are talking with (never reveal it to anyone else):",
      lines(this.list("user", userId)),
    ].join("\n");
  }

  #read(file: string, scope: MemoryScope): MemoryEntry | undefined {
    const text = readFileSync(file, "utf8");
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!match) return undefined;
    const fm = MemoryFrontmatter.safeParse(parseYaml(match[1] ?? ""));
    if (!fm.success) return undefined;
    return { ...fm.data, body: (match[2] ?? "").trim(), scope, updatedAt: statSync(file).mtime };
  }

  #reindex(scope: MemoryScope, userId?: string) {
    const dir = this.dir(scope, userId);
    const entries = this.list(scope, userId);
    const body = entries.map((e) => `- [[${e.name}]]: ${e.description}`).join("\n");
    writeFileSync(join(dir, MEMORY_INDEX), body ? `${body}\n` : "");
  }
}
