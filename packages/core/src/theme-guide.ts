import { THEME_CORNERS, THEME_FONTS, THEME_NEUTRALS, THEME_WORDS } from "./theme.js";

const wordList = Object.entries(THEME_WORDS)
  .map(([key, w]) => `  - \`${key}\`: ${w.means} (default "${w.default}")`)
  .join("\n");

/**
 * The step-by-step routine an AI follows to build a custom theme with someone. The Captain reads
 * it with the theme_build_guide tool; docs/custom-themes.md carries the same text for people who
 * build one with an outside AI and import the file.
 */
export const THEME_BUILD_GUIDE = `# Building a custom theme

A custom theme changes how Shipmate looks and talks for the person using it: colors, grays,
font, corners, logo, the app's words, and the crew's voice. It is not limited to ships: a
trainer adventure, a company with a CEO, a space station, a cozy cottage, anything.

Work through the steps in order, one question at a time. Use \`ask_person\` with 3 to 5 short
choices wherever a tap is easier than typing, and always allow their own answer. Keep every
message short. Do not ask about things you can decide yourself; make a good pick and say so.

## 1. The idea
Ask what the theme is about. If they already said, confirm it in one line and move on.
Example choices: "Trainer adventure", "Company with a CEO", "Space crew", "Fantasy guild",
"Cozy cottage".

## 2. The mood
Ask how it should feel: for example playful, calm, professional, bold, or retro.

## 3. The words
Propose a word for each of these, fitting the idea. Show all of them in one short list and ask
if they look right (choices such as "Looks great", "More playful", "More serious"):
${wordList}
Words are short (1 to 3 words, at most 24 characters). Page names are capitalized; \`crewMember\`
is lowercase. Example for a company: captain "CEO", crew "Team", crewMember "team member",
bridge "Office", watches "Schedule", shipyard "Projects", appName "HQ".

## 4. Colors and style
Offer 3 or 4 accent colors that fit, each as a name plus hex (for example "Ember red #dc2626").
Then pick, or ask about:
- \`neutral\`, the grays for pages and text: ${THEME_NEUTRALS.join(", ")} ("tinted" takes a
  hint of the accent; "stone" is warm; "slate" is cool, the default).
- \`font\`: ${THEME_FONTS.join(", ")}.
- \`corners\`: ${THEME_CORNERS.join(", ")}.
Any accent works: Shipmate works out the light and dark shades itself and keeps text readable.

## 5. The logo
Draw an original, simple, bold mark as an SVG:
- One \`<svg>\` with \`viewBox="0 0 64 64"\`, shapes only: g, path, circle, ellipse, rect, line,
  polyline, polygon, and gradients, clipPath or mask in defs.
- Draw in \`currentColor\` (or white) on a transparent background: it is shown in white on a
  rounded tile of the accent color. Use \`opacity\` for depth. Keep it readable at 20 pixels:
  a few large shapes, no fine detail, no text.
- No style or class attributes, scripts, images, links or text elements.
- Make it your own. Never copy a logo, mascot or character from a brand or franchise (no
  Poké Balls, no company logos): draw something new that evokes the idea, such as an original
  creature, emblem, badge, or symbol.

## 6. The voice
Write 3 to 6 sentences, as instructions to the crew, on how to talk with this person: tone,
a few signature phrases, and to use the theme's words (the coordinator is the \`captain\` word,
the team is the \`crew\` word). Flavor only: stay clear, accurate and helpful, keep answers
as short as before, drop the flavor for serious, sensitive or urgent topics, and never claim
to be a real person or a trademarked character.

## 7. Save and preview
Call \`save_theme\` with everything. If it reports problems, fix them all and call it again
(pass the same \`id\` once you have one). The person then sees a preview card in the chat with
a Try it button. Ask whether they want any changes, and save again with the same \`id\` for
each change; nothing about the theme needs to start over.

## 8. Wrap up
- They can switch any time in Settings > Appearance, including back to the standard Shipmate
  look; \`use_theme\` switches for them if they ask in chat.
- The crew's own names (the coordinator's name included) are shared by everyone. Only if the
  person is an owner or admin and asks, offer to rename crew members to fit with
  \`edit_crew_member\`, after saying it changes the names for everyone.
`;
