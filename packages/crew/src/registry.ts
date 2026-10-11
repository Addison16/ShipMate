import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREW_FILES,
  type CrewManifest,
  type CrewManifestInput,
  CrewManifest as CrewManifestSchema,
  CrewSlug,
} from "@shipmate/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type CrewFolder, loadCrewFolder, writeCrewFolder } from "./folder.js";

/** Thrown for input a person or a bot can fix (bad YAML, a taken slug, ...). */
export class CrewValidationError extends Error {}

/**
 * The crew on disk under `/data/crew`. Disk is the source of truth; the server mirrors it into
 * the database for listing and attribution.
 */
export class CrewRegistry {
  constructor(readonly root: string) {}

  list(): CrewFolder[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && CrewSlug.safeParse(d.name).success)
      .filter((d) => existsSync(join(this.root, d.name, CREW_FILES.manifest)))
      .map((d) => loadCrewFolder(join(this.root, d.name)));
  }

  has(slug: string): boolean {
    return existsSync(join(this.root, slug, CREW_FILES.manifest));
  }

  get(slug: string): CrewFolder {
    const parsed = CrewSlug.safeParse(slug);
    if (!parsed.success || !this.has(slug))
      throw new CrewValidationError(`no crew member "${slug}"`);
    return loadCrewFolder(join(this.root, slug));
  }

  readManifestYaml(slug: string): string {
    return readFileSync(join(this.root, slug, CREW_FILES.manifest), "utf8");
  }

  create(slug: string, manifest: CrewManifestInput, persona: string): CrewFolder {
    const s = CrewSlug.safeParse(slug);
    if (!s.success) throw new CrewValidationError(s.error.issues[0]?.message ?? "bad slug");
    if (this.has(slug))
      throw new CrewValidationError(`a crew member called "${slug}" already exists`);
    const m = CrewManifestSchema.safeParse(manifest);
    if (!m.success) throw new CrewValidationError(formatIssues(m.error.issues));
    if (m.data.captain) throw new CrewValidationError("there is only one Captain");
    return writeCrewFolder(join(this.root, slug), m.data, persona);
  }

  /** Replace crew.yaml and/or CREW.md. The YAML is validated before anything is written. */
  update(slug: string, patch: { manifestYaml?: string; persona?: string }): CrewFolder {
    const current = this.get(slug);
    const dir = current.dir;
    if (patch.manifestYaml !== undefined) {
      const next = parseManifestYaml(patch.manifestYaml);
      if (next.captain !== current.manifest.captain) {
        throw new CrewValidationError("the captain flag cannot be changed");
      }
      writeFileSync(join(dir, CREW_FILES.manifest), patch.manifestYaml);
    }
    if (patch.persona !== undefined) {
      const p = patch.persona.endsWith("\n") ? patch.persona : `${patch.persona}\n`;
      writeFileSync(join(dir, CREW_FILES.persona), p);
    }
    return loadCrewFolder(dir);
  }

  /** Merge structured changes into crew.yaml (used by the Captain's edit tool). */
  patchManifest(slug: string, changes: Partial<CrewManifest>): CrewFolder {
    const current = this.get(slug);
    const merged = { ...current.manifest, ...changes, captain: current.manifest.captain };
    const parsed = CrewManifestSchema.safeParse(merged);
    if (!parsed.success) throw new CrewValidationError(formatIssues(parsed.error.issues));
    writeFileSync(join(current.dir, CREW_FILES.manifest), stringifyYaml(parsed.data));
    return loadCrewFolder(current.dir);
  }

  /**
   * First boot: copy the Captain template into place. The coordinator's slug is fixed
   * ("captain") so references stay stable; its display name is whatever the owner picked.
   */
  seedCaptain(templateDir: string, options: { name?: string; model?: string } = {}): CrewFolder {
    const dir = join(this.root, CAPTAIN_SLUG);
    if (!this.has(CAPTAIN_SLUG)) cpSync(templateDir, dir, { recursive: true });
    const folder = loadCrewFolder(dir);
    const changes: Partial<CrewManifest> = {};
    if (options.name && options.name !== folder.manifest.name) changes.name = options.name;
    if (options.model && options.model !== folder.manifest.model) changes.model = options.model;
    if (Object.keys(changes).length) {
      this.patchManifest(CAPTAIN_SLUG, changes);
      if (changes.name) renamePersona(dir, folder.manifest.name, changes.name);
    }
    // Normalizes crew.yaml and creates the standard subfolders the template does not ship.
    const seeded = loadCrewFolder(dir);
    return writeCrewFolder(dir, seeded.manifest, seeded.persona);
  }

  /**
   * Replace a crew member's CREW.md with a newer stock version, but only while it is still
   * exactly an earlier stock version (with the Captain's rename applied): people's edits are
   * never overwritten. Returns whether it changed.
   */
  upgradeStockPersona(slug: string, stock: { current: string; previous: string[] }): boolean {
    if (!this.has(slug)) return false;
    const folder = this.get(slug);
    // Only the Captain's persona is renamed (see seedCaptain); the stock one says "Captain".
    const render = (t: string) =>
      (slug === CAPTAIN_SLUG ? renamePersonaText(t, "Captain", folder.manifest.name) : t).trim();
    const mine = folder.persona.trim();
    if (mine === render(stock.current)) return false;
    if (!stock.previous.some((p) => render(p) === mine)) return false;
    writeFileSync(join(this.root, slug, CREW_FILES.persona), `${render(stock.current)}\n`);
    return true;
  }
}

export const CAPTAIN_SLUG = "captain";

export function parseManifestYaml(text: string): CrewManifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new CrewValidationError(`crew.yaml is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = CrewManifestSchema.safeParse(raw);
  if (!parsed.success) throw new CrewValidationError(formatIssues(parsed.error.issues));
  return parsed.data;
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** Replace the coordinator's old name in the first heading and the "You are the X" line. */
function renamePersona(dir: string, from: string, to: string) {
  const file = join(dir, CREW_FILES.persona);
  writeFileSync(file, renamePersonaText(readFileSync(file, "utf8"), from, to));
}

export function renamePersonaText(text: string, from: string, to: string): string {
  if (from === to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`^# ${escaped}$`, "m"), `# ${to}`)
    .replace(new RegExp(`You are the ${escaped}\\b`), `You are ${to}, the Captain`);
}
