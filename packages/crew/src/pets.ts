import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ActingUser } from "./tools.js";

/** What the Captain's pet tools need from the server. */
export interface PetHost {
  /** Who has a pet, and how pictures get made here (an image model, or the Captain draws). */
  status(): Promise<{ roster: string; paints: boolean; painter: string }>;
  /**
   * Make a draft pet, show it to the person and ask whether to keep it. Returns what to do
   * next, written for the model.
   */
  make(
    spec: { crew: string; name: string; look: string; svg?: string | undefined },
    signal: AbortSignal | undefined,
  ): Promise<string>;
  /** Show or hide a crew member's pet. */
  show(crew: string, show: boolean): Promise<string>;
}

/** A finished example the Captain can copy when it draws a pet itself. */
export const EXAMPLE_PET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <circle cx="40" cy="30" r="10" fill="#5bb8b0" stroke="#2b2b3a" stroke-width="3"/>
  <circle cx="88" cy="30" r="10" fill="#5bb8b0" stroke="#2b2b3a" stroke-width="3"/>
  <ellipse cx="64" cy="88" rx="34" ry="28" fill="#5bb8b0" stroke="#2b2b3a" stroke-width="3"/>
  <ellipse cx="64" cy="96" rx="20" ry="15" fill="#f4e9d8"/>
  <ellipse cx="44" cy="112" rx="10" ry="6" fill="#4a9e97" stroke="#2b2b3a" stroke-width="3"/>
  <ellipse cx="84" cy="112" rx="10" ry="6" fill="#4a9e97" stroke="#2b2b3a" stroke-width="3"/>
  <circle cx="64" cy="52" r="30" fill="#5bb8b0" stroke="#2b2b3a" stroke-width="3"/>
  <ellipse cx="64" cy="63" rx="14" ry="10" fill="#f4e9d8"/>
  <circle cx="52" cy="48" r="4.5" fill="#2b2b3a"/>
  <circle cx="53.5" cy="46.5" r="1.5" fill="#ffffff"/>
  <circle cx="76" cy="48" r="4.5" fill="#2b2b3a"/>
  <circle cx="77.5" cy="46.5" r="1.5" fill="#ffffff"/>
  <ellipse cx="64" cy="58" rx="4" ry="3" fill="#2b2b3a"/>
  <path d="M58 64 Q64 69 70 64" fill="none" stroke="#2b2b3a" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse cx="43" cy="60" rx="5" ry="3" fill="#ff8fa3" opacity="0.6"/>
  <ellipse cx="85" cy="60" rx="5" ry="3" fill="#ff8fa3" opacity="0.6"/>
  <path d="M50 26 L64 4 L78 26 Z" fill="#e8b04a" stroke="#2b2b3a" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="64" cy="4" r="4" fill="#ff8fa3" stroke="#2b2b3a" stroke-width="2"/>
</svg>`;

/** How to draw a pet as an SVG, for models with no image model to call. */
export const SVG_RULES = [
  "How to draw the pet as an SVG:",
  '- Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"> and end with </svg>.',
  "- Use only these shapes: circle, ellipse, rect, path, polygon, line, polyline, g. Gradients are fine inside <defs>.",
  "- No text, no <image>, no <script>, no <style>, no links.",
  "- Draw from back to front: ears, tail and body first, then feet, then the head, then the face and the hat or accessory on top.",
  "- Body: a big ellipse low in the middle (about cx 64, cy 88). Head: a circle above it (about cx 64, cy 52, r 30). Leave the background empty.",
  "- Face: two dark eyes with a tiny white dot each, a small nose, a curved smile, and pink cheeks with opacity 0.6. Big head and big eyes look cute.",
  '- Give every main shape stroke="#2b2b3a" stroke-width="3", and fill it with the colors from the look.',
  "- Keep it under 40 shapes.",
  "",
  "A finished example (a teal creature with a party hat) you can change:",
  EXAMPLE_PET_SVG,
].join("\n");

/** The step-by-step pet build, written so that small models can follow it. */
export function petGuide(status: { roster: string; paints: boolean; painter: string }): string {
  return [
    "# Making a pet",
    "",
    "A pet is a small, original cartoon creature that hangs out next to one crew member in chat and dances while they work. Pets are optional. Follow these steps in order, one step per message, and keep each message short.",
    "",
    "Step 1. Pick the crew member. If the person did not say who, call ask_person with the question 'Who gets a pet?' and one choice per crew member from the list below.",
    "Step 2. Pick the creature. Call ask_person 'What kind of pet?' with 4 short ideas that fit that crew member's job (for meals: a round otter chef; for money: a tidy owl; for code: a small robot crab). They can type their own.",
    "Step 3. Pick the style. Call ask_person 'Which style?' with these choices: Cute and round, Pixel art, Cozy storybook, Bold cartoon.",
    "Step 4. Pick a name. Call ask_person 'What should we call it?' with 4 short, friendly names that fit.",
    "Step 5. Write the look: ONE sentence under 30 words with the creature, 2 or 3 colors, one small accessory linked to the job, and the style. Example: 'a round sea otter in teal and cream with a tiny chef's hat, cute and round style'.",
    status.paints
      ? "Step 6. Call make_pet with crew, name and look. A picture is made for you (it can take a minute). The person sees the pet and taps Keep it, Try again or Change something. Do exactly what make_pet tells you next."
      : "Step 6. Draw the pet yourself as an SVG (rules below), then call make_pet with crew, name, look and svg. The person sees the pet and taps Keep it, Try again or Change something. Do exactly what make_pet tells you next.",
    "Step 7. When it is kept, say in one line that the pet is aboard. They can hide it on that crew member's page, or ask you.",
    "",
    "Rules:",
    "- Original creatures only. Never copy a character from a game, film, show or brand. If they ask for one (for example a Pokémon), make an original creature in that spirit and say so in a few words.",
    "- No text or letters in the pet.",
    "- To hide or bring back a pet later, use set_pet.",
    "",
    `Pictures: ${status.painter}`,
    "",
    "Crew and their pets:",
    status.roster,
    ...(status.paints ? [] : ["", SVG_RULES]),
  ].join("\n");
}

/** Pet building, for the Captain only. */
export function petTools(host: PetHost, user: ActingUser): ToolDefinition[] {
  const requireManager = () => {
    if (user.role === "member") {
      throw new Error(
        `${user.displayName} is a member; only an owner or admin can give the crew pets. Suggest they ask one.`,
      );
    }
  };
  return [
    defineTool({
      name: "pet_guide",
      label: "Pet guide",
      description:
        "Read this first whenever someone wants a pet for a crew member (a small creature that hangs out in chat and dances while they work). It gives the steps to follow, who has a pet, and how pictures get made.",
      promptSnippet: "pet_guide: read the steps first when someone wants a pet for a crew member",
      parameters: Type.Object({}),
      async execute() {
        const text = petGuide(await host.status());
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    }),
    defineTool({
      name: "make_pet",
      label: "Make pet",
      description:
        "Make a pet for a crew member and show it to the person, who keeps it or asks for another try. Follow pet_guide first. Give svg only when pet_guide says you draw the pet yourself.",
      parameters: Type.Object({
        crew: Type.String({ description: "the crew member's slug, e.g. galley" }),
        name: Type.String({ description: "the pet's name, e.g. Biscuit" }),
        look: Type.String({
          description:
            "one sentence under 30 words: creature, 2 or 3 colors, one accessory, the style",
        }),
        svg: Type.Optional(
          Type.String({ description: "the pet drawn as an SVG, when you draw it yourself" }),
        ),
      }),
      executionMode: "sequential",
      async execute(_id, p, signal) {
        requireManager();
        const text = await host.make(
          {
            crew: p.crew.trim(),
            name: p.name.trim().slice(0, 40),
            look: p.look.trim().slice(0, 400),
            ...(p.svg?.trim() ? { svg: p.svg.trim() } : {}),
          },
          signal,
        );
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    }),
    defineTool({
      name: "set_pet",
      label: "Show or hide pet",
      description:
        "Hide a crew member's pet, or bring a hidden one back. To make a new pet, use pet_guide instead.",
      parameters: Type.Object({
        crew: Type.String({ description: "the crew member's slug" }),
        show: Type.Boolean({ description: "true shows the pet, false hides it" }),
      }),
      async execute(_id, p) {
        requireManager();
        const text = await host.show(p.crew.trim(), p.show);
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    }),
  ];
}
