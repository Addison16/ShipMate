/**
 * Crew pets: an optional small creature next to a crew member that hangs out in chat and dances
 * while they work. The Captain builds one with the person (pet_guide, make_pet); the picture is
 * drawn by an image model when one is set up, or by the Captain itself as an SVG.
 */

/** A crew member's pet, when it has one (a picture exists), shown or hidden. */
export interface PetDto {
  name: string;
  /** Off hides it everywhere; the picture is kept for turning it back on. */
  shown: boolean;
  /** GET this for the picture; it changes when the picture does. */
  url: string;
}

/** A pet the Captain drew while building one, shown in chat before the person keeps it. */
export interface PetPreviewMeta {
  crew: { slug: string; name: string };
  name: string;
  /** GET this for the draft picture. */
  url: string;
}

/**
 * Where pet pictures come from:
 * - draw: the Captain draws an SVG itself (always works, no image model needed);
 * - provider: a configured OpenAI or OpenAI-compatible provider's /images endpoint and key;
 * - custom: any OpenAI-compatible image server (e.g. a local one) at baseUrl.
 * There is no ChatGPT-plan option: OpenAI documents Sign in with ChatGPT for chat only, and
 * Shipmate only uses subscriptions in documented ways.
 */
export type PetImageSource = "draw" | "provider" | "custom";

/** GET /api/pets/settings (owner) → PetSettingsDto. Keys are never returned. */
export interface PetSettingsDto {
  source: PetImageSource;
  providerId: string | null;
  baseUrl: string | null;
  /** Image model; "" picks a sensible one. */
  model: string;
  hasKey: boolean;
  /** Providers whose key can be reused for pictures. */
  providers: Array<{ id: string; label: string; kind: string }>;
}

/**
 * PUT /api/pets/settings (owner) { source?, providerId?, baseUrl?, model?, apiKey? } → PetSettingsDto.
 * apiKey "" removes the stored key (custom only).
 * PUT /api/crew/:slug/pet (admin) { enabled } → { crew: CrewDetailDto }; shows or hides the pet.
 * GET /api/crew/:slug/pet → the picture; ?draft=<id> for a draft from a pet build.
 */
