import type {
  CrewDetailDto,
  CrewDto,
  MessageDto,
  PetDto,
  PetImageSource,
  PetPreviewMeta,
  PetSettingsDto,
} from "@shipmate/core";
import { request } from "../api.js";
import type { TimelineItem } from "./timeline.js";

export const petsApi = {
  settings: () => request<PetSettingsDto>("GET", "/api/pets/settings"),
  update: (body: {
    source?: PetImageSource;
    providerId?: string | null;
    baseUrl?: string | null;
    model?: string;
    apiKey?: string;
  }) => request<PetSettingsDto>("PUT", "/api/pets/settings", body),
  /** Show or hide a crew member's pet. */
  setShown: (slug: string, enabled: boolean) =>
    request<{ crew: CrewDetailDto }>("PUT", `/api/crew/${encodeURIComponent(slug)}/pet`, {
      enabled,
    }),
};

/** What a pet is doing: hanging out, dancing while its crew member works, or a happy hop. */
export type PetMood = "idle" | "working" | "happy";

/** The message that starts a pet build with the Captain. */
export function petBuildPrompt(crewName: string, again: boolean): string {
  return again ? `Let's make a new pet for ${crewName}.` : `Let's make a pet for ${crewName}!`;
}

/** Where pictures come from, in plain words, for the settings picker. */
export const PET_SOURCES: Array<{ id: PetImageSource; label: string }> = [
  { id: "draw", label: "The Captain draws them (no setup)" },
  { id: "provider", label: "A provider (OpenAI or OpenAI-compatible)" },
  { id: "custom", label: "An image server (local or hosted)" },
];

/** A pet draft shown in a conversation, read defensively from `meta.petPreview`. */
export function petPreview(message: MessageDto): PetPreviewMeta | null {
  const p = message.meta?.petPreview as Partial<PetPreviewMeta> | undefined;
  if (
    !p ||
    typeof p.name !== "string" ||
    typeof p.url !== "string" ||
    !p.url.startsWith("/api/crew/") ||
    typeof p.crew?.slug !== "string" ||
    typeof p.crew?.name !== "string"
  ) {
    return null;
  }
  return { crew: { slug: p.crew.slug, name: p.crew.name }, name: p.name, url: p.url };
}

export interface DockPet {
  slug: string;
  crewName: string;
  pet: PetDto;
  working: boolean;
}

/** Most pets that sit on the message box at once; more would crowd a phone. */
export const MAX_DOCK_PETS = 3;

/**
 * The pets that hang out in a conversation: whoever answers it (the Captain, or the crew member
 * of a direct chat) and crew members who have spoken in it, most recent first, each with
 * whether its crew member is working on a reply right now.
 */
export function dockPets(items: TimelineItem[], crew: CrewDto[], host: CrewDto | null): DockPet[] {
  const order: string[] = [];
  const seen = (slug: string) => {
    const at = order.indexOf(slug);
    if (at >= 0) order.splice(at, 1);
    order.unshift(slug);
  };
  for (const it of items) {
    if (it.kind === "stream") seen(it.crew.slug);
    else if (it.kind === "handoff") seen(it.to.slug);
    else if (it.kind === "message" && it.message.author.kind === "crew") {
      seen(it.message.author.slug);
    }
  }
  if (host && !order.includes(host.slug)) order.push(host.slug);
  const live = new Set(
    items.flatMap((it) => (it.kind === "stream" && !it.done ? [it.crew.slug] : [])),
  );
  return order
    .flatMap((slug): DockPet[] => {
      const member = crew.find((c) => c.slug === slug) ?? (host?.slug === slug ? host : null);
      return member?.pet?.shown
        ? [{ slug, crewName: member.name, pet: member.pet, working: live.has(slug) }]
        : [];
    })
    .slice(0, MAX_DOCK_PETS);
}

/** A small, stable offset per pet so several pets don't move in lockstep. */
export function petPhase(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 1000) / 1000;
}
