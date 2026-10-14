import type { CrewDto, MessageDto, PetDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { dockPets, MAX_DOCK_PETS, petBuildPrompt, petPhase, petPreview } from "./pets.js";
import type { TimelineItem } from "./timeline.js";

function member(slug: string, pet: PetDto | null, captain = false): CrewDto {
  return {
    slug,
    name: slug[0]?.toUpperCase() + slug.slice(1),
    role: "role",
    model: "default",
    captain,
    backend: "pi",
    visibility: "shared",
    status: "active",
    tools: [],
    mcp: [],
    skills: [],
    avatar: null,
    pet,
  };
}
const pet = (name: string, shown = true): PetDto => ({ name, shown, url: `/api/crew/x/pet?v=1` });

function message(id: string, slug: string, meta: MessageDto["meta"] = null): TimelineItem {
  return {
    kind: "message",
    key: id,
    message: {
      id,
      conversationId: "c",
      role: "assistant",
      content: "hi",
      author: { kind: "crew", slug, name: slug },
      meta,
      createdAt: "2026-10-14T00:00:00.000Z",
    },
  };
}

describe("dockPets", () => {
  const captain = member("captain", pet("Pip"), true);
  const galley = member("galley", pet("Biscuit"));
  const purser = member("purser", null);
  const crew = [captain, galley, purser];

  it("shows the host's pet in a fresh chat, and none when it has no pet or it is hidden", () => {
    expect(dockPets([], crew, captain)).toEqual([
      { slug: "captain", crewName: "Captain", pet: captain.pet, working: false },
    ]);
    expect(dockPets([], crew, purser)).toEqual([]);
    const hidden = member("captain", pet("Pip", false), true);
    expect(dockPets([], [hidden], hidden)).toEqual([]);
  });

  it("adds crew who speak, most recent first, and marks who is working", () => {
    const items: TimelineItem[] = [
      message("1", "captain"),
      { kind: "handoff", key: "h", from: captain, to: galley, task: "plan meals" },
      message("2", "purser"),
      {
        kind: "stream",
        key: "s",
        streamId: "s",
        crew: { slug: "galley", name: "Galley" },
        text: "",
        tools: [],
        done: false,
      },
    ];
    expect(dockPets(items, crew, captain).map((p) => [p.slug, p.working])).toEqual([
      ["galley", true],
      ["captain", false],
    ]);
  });

  it(`shows at most ${MAX_DOCK_PETS}`, () => {
    const many = ["a", "b", "c", "d", "e"].map((s) => member(s, pet(s)));
    const items = many.map((m) => message(m.slug, m.slug));
    expect(dockPets(items, many, null).map((p) => p.slug)).toEqual(["e", "d", "c"]);
  });
});

describe("petPreview", () => {
  it("reads a well-formed preview and ignores anything else", () => {
    const meta = {
      petPreview: {
        crew: { slug: "galley", name: "Galley" },
        name: "Biscuit",
        url: "/api/crew/galley/pet?draft=abc",
      },
    };
    const it0 = message("1", "x", meta) as Extract<TimelineItem, { kind: "message" }>;
    expect(petPreview(it0.message)).toEqual(meta.petPreview);
    const outside = message("2", "x", {
      petPreview: { ...meta.petPreview, url: "https://evil.example/x.png" },
    }) as Extract<TimelineItem, { kind: "message" }>;
    expect(petPreview(outside.message)).toBeNull();
    const none = message("3", "x") as Extract<TimelineItem, { kind: "message" }>;
    expect(petPreview(none.message)).toBeNull();
  });
});

describe("helpers", () => {
  it("words the build request and spreads pets' timing", () => {
    expect(petBuildPrompt("Galley", false)).toBe("Let's make a pet for Galley!");
    expect(petBuildPrompt("Galley", true)).toBe("Let's make a new pet for Galley.");
    expect(petPhase("Biscuit")).toBe(petPhase("Biscuit"));
    expect(petPhase("Biscuit")).toBeGreaterThanOrEqual(0);
    expect(petPhase("Biscuit")).toBeLessThan(1);
  });
});
