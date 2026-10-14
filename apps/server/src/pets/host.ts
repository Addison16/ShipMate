import type { PetPreviewMeta } from "@shipmate/core";
import { type PetHost, type QuestionHost, SVG_RULES } from "@shipmate/crew";
import type { CrewService } from "../services/crew.js";
import { keepDraft, type PetExt, petPicture, saveDraft } from "./files.js";
import type { PetService } from "./service.js";
import { checkPetSvg } from "./svg.js";

export const KEEP = "Keep it";
export const AGAIN = "Try again";
export const CHANGE = "Change something";

/**
 * The Captain's pet tools for one turn: make a draft (an image model's picture, or the
 * Captain's own SVG), show it in the conversation, ask the person, and keep it on a yes.
 * Every answer tells the model exactly what to do next, so small models finish the build.
 */
export function petHost(deps: {
  crew: CrewService;
  pets: PetService;
  /** The crew the person may see (not retired). */
  roster: () => Promise<Array<{ slug: string; name: string; role: string }>>;
  /** Put the draft in the conversation. */
  preview: (meta: PetPreviewMeta) => Promise<void>;
  ask: QuestionHost["ask"];
  personName: string;
}): PetHost {
  const find = async (slug: string) => {
    const member = (await deps.roster()).find((c) => c.slug === slug);
    if (!member) throw new Error(`no crew member "${slug}"; use the slugs pet_guide lists`);
    return member;
  };

  return {
    async status() {
      const lines = (await deps.roster()).map((c) => {
        const pet = deps.crew.folder(c.slug).manifest.pet;
        const has = pet?.image && petPicture(deps.crew.folder(c.slug));
        const state = has
          ? `pet ${pet?.name ?? "(unnamed)"}, ${pet?.enabled ? "shown" : "hidden"}`
          : "no pet";
        return `- ${c.slug}: ${c.name} (${c.role}); ${state}`;
      });
      return { roster: lines.join("\n") || "- (no crew)", ...(await deps.pets.painter()) };
    },

    async make(spec, signal) {
      const member = await find(spec.crew);
      if (!spec.name) throw new Error("give the pet a name");
      if (!spec.look) throw new Error("describe the look in one sentence");
      const { paints } = await deps.pets.painter();
      let picture: { bytes: Uint8Array; ext: PetExt } | null = null;
      if (paints && !spec.svg) {
        try {
          picture = await deps.pets.paint(spec.look, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          return [
            `The picture maker failed (${(err as Error).message}). Draw the pet yourself instead: call make_pet again with the same crew, name and look, plus an svg.`,
            "",
            SVG_RULES,
          ].join("\n");
        }
      } else if (!spec.svg) {
        return [
          "No image model is set up here, so draw the pet yourself: call make_pet again with the same crew, name and look, plus an svg.",
          "",
          SVG_RULES,
        ].join("\n");
      }
      if (!picture) {
        const checked = checkPetSvg(spec.svg ?? "");
        if ("error" in checked) {
          return `The svg was not accepted: ${checked.error} Fix it and call make_pet again with the corrected svg.`;
        }
        picture = { bytes: Buffer.from(checked.svg), ext: "svg" };
      }

      const folder = deps.crew.folder(member.slug);
      const draft = saveDraft(folder, picture.bytes, picture.ext);
      await deps.preview({
        crew: { slug: member.slug, name: member.name },
        name: spec.name,
        url: `/api/crew/${member.slug}/pet?draft=${draft}`,
      });
      const answer = await deps.ask(
        {
          text: `Keep ${spec.name} as ${member.name}'s pet?`,
          options: [
            { label: KEEP },
            { label: AGAIN },
            { label: CHANGE, detail: "or type what to change" },
          ],
        },
        signal,
      );
      const who = deps.personName;
      if (answer === null) {
        return `${who} skipped it, so the pet was not saved. Say they can ask for a pet again any time. Do not call make_pet again now.`;
      }
      if (answer === KEEP) {
        const image = keepDraft(deps.crew.folder(member.slug), draft);
        await deps.crew.patch(member.slug, {
          pet: { enabled: true, name: spec.name, look: spec.look, image },
        });
        return `Saved. ${spec.name} is now ${member.name}'s pet and hangs out in chat. Tell ${who} that in one short line. The build is done; do not call make_pet again.`;
      }
      if (answer === AGAIN) {
        return `${who} wants another try. Call make_pet again with the same crew and name, and change the look a little (a different pose, colors or accessory).`;
      }
      if (answer === CHANGE) {
        return `${who} wants something changed. Call ask_person 'What should change?' with 4 short choices (for example: colors, the accessory, the creature, the style), then rewrite the look and call make_pet again.`;
      }
      return `${who} wants this changed: "${answer}". Rewrite the look to include it, then call make_pet again with the same crew and name.`;
    },

    async show(slug, show) {
      const member = await find(slug);
      const folder = deps.crew.folder(member.slug);
      const pet = folder.manifest.pet;
      if (!pet?.image || !petPicture(folder)) {
        return show
          ? `${member.name} has no pet yet. To make one, follow pet_guide.`
          : `${member.name} has no pet.`;
      }
      await deps.crew.patch(member.slug, { pet: { ...pet, enabled: show } });
      return show
        ? `${pet.name ?? "The pet"} is back with ${member.name}.`
        : `${pet.name ?? "The pet"} is hidden. It can come back any time.`;
    },
  };
}
