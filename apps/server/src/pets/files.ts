import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CREW_FILES, PET_IMAGE_FILE, type PetDto } from "@shipmate/core";
import type { CrewFolder } from "@shipmate/crew";

/** Picture kinds a pet can be stored as, by file extension. */
export const PET_TYPES = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
} as const;
export type PetExt = keyof typeof PET_TYPES;

/** Drafts kept per crew member; older ones are removed (their chat previews then show nothing). */
const KEEP_DRAFTS = 12;
const DRAFT_ID = /^[a-f0-9]{12}$/;

const petDir = (folder: CrewFolder) => join(folder.dir, CREW_FILES.petDir);
const draftsDir = (folder: CrewFolder) => join(petDir(folder), "drafts");

/** The pet as the web app shows it, when its picture exists (shown or hidden). */
export function petDto(folder: CrewFolder): PetDto | null {
  const pet = folder.manifest.pet;
  if (!pet?.image) return null;
  const file = join(petDir(folder), pet.image);
  if (!existsSync(file)) return null;
  const version = Math.round(statSync(file).mtimeMs).toString(36);
  return {
    name: pet.name ?? `${folder.manifest.name}'s pet`,
    shown: pet.enabled,
    url: `/api/crew/${folder.slug}/pet?v=${version}`,
  };
}

/** The kept picture, whether or not the pet is shown right now. */
export function petPicture(folder: CrewFolder): { file: string; type: string } | null {
  const image = folder.manifest.pet?.image;
  if (!image || !PET_IMAGE_FILE.test(image)) return null;
  const file = join(petDir(folder), image);
  return existsSync(file) ? { file, type: typeOf(image) } : null;
}

export function draftPicture(
  folder: CrewFolder,
  id: string,
): { file: string; type: string } | null {
  if (!DRAFT_ID.test(id)) return null;
  for (const ext of Object.keys(PET_TYPES) as PetExt[]) {
    const file = join(draftsDir(folder), `${id}.${ext}`);
    if (existsSync(file)) return { file, type: PET_TYPES[ext] };
  }
  return null;
}

/** Store a draft picture and return its id. */
export function saveDraft(folder: CrewFolder, bytes: Uint8Array, ext: PetExt): string {
  const dir = draftsDir(folder);
  mkdirSync(dir, { recursive: true });
  const id = randomBytes(6).toString("hex");
  writeFileSync(join(dir, `${id}.${ext}`), bytes);
  const old = readdirSync(dir)
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(KEEP_DRAFTS);
  for (const f of old) rmSync(join(dir, f.name), { force: true });
  return id;
}

/** Make a draft the pet's picture; returns the file name to put in crew.yaml. */
export function keepDraft(folder: CrewFolder, id: string): string {
  const draft = draftPicture(folder, id);
  if (!draft) throw new Error("that draft is gone; make the pet again");
  const ext = draft.file.slice(draft.file.lastIndexOf(".") + 1);
  const image = `pet.${ext}`;
  for (const other of Object.keys(PET_TYPES)) {
    if (other !== ext) rmSync(join(petDir(folder), `pet.${other}`), { force: true });
  }
  copyFileSync(draft.file, join(petDir(folder), image));
  return image;
}

function typeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1) as PetExt;
  return PET_TYPES[ext] ?? "application/octet-stream";
}

/** Headers for serving a pet picture: an SVG can never run anything, even opened on its own. */
export const PICTURE_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "cache-control": "private, max-age=31536000, immutable",
};
