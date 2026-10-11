import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CREW_FILES,
  type CrewManifest,
  type CrewManifestInput,
  CrewManifest as CrewManifestSchema,
  CrewSlug,
} from "@shipmate/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface CrewFolder {
  slug: string;
  dir: string;
  manifest: CrewManifest;
  /** CREW.md contents: the persona and standing instructions. */
  persona: string;
}

/** Read a crew member from its folder. Disk is the source of truth. */
export function loadCrewFolder(dir: string): CrewFolder {
  const slug = CrewSlug.parse(basename(dir));
  const manifestPath = join(dir, CREW_FILES.manifest);
  const personaPath = join(dir, CREW_FILES.persona);
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} not found`);
  const manifest = CrewManifestSchema.parse(parseYaml(readFileSync(manifestPath, "utf8")));
  const persona = existsSync(personaPath) ? readFileSync(personaPath, "utf8") : "";
  return { slug, dir, manifest, persona };
}

/** Create or overwrite a crew folder with its manifest, persona and standard subfolders. */
export function writeCrewFolder(
  dir: string,
  manifest: CrewManifestInput,
  persona: string,
): CrewFolder {
  CrewSlug.parse(basename(dir));
  const parsed = CrewManifestSchema.parse(manifest);
  mkdirSync(dir, { recursive: true });
  for (const sub of [
    CREW_FILES.skillsDir,
    CREW_FILES.memoryDir,
    CREW_FILES.promptsDir,
    CREW_FILES.sessionsDir,
  ]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, CREW_FILES.manifest), stringifyYaml(parsed));
  writeFileSync(join(dir, CREW_FILES.persona), persona.endsWith("\n") ? persona : `${persona}\n`);
  return loadCrewFolder(dir);
}
