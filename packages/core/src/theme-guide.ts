import { THEME_CORNERS, THEME_FONTS, THEME_NEUTRALS, THEME_WORDS } from "./theme.js";

const wordList = Object.entries(THEME_WORDS)
  .map(([key, w]) => `- ${key}: ${w.means}. Normal: "${w.default}".`)
  .join("\n");

/**
 * The routine an AI follows to build a custom theme with someone. Written for small local
 * models: short numbered steps, one thing per step, an example to copy, and nothing that can
 * go badly wrong (save_theme fixes or drops anything it cannot use and says so). The Captain
 * reads it with theme_build_guide; docs/custom-themes.md carries the same text.
 */
export const THEME_BUILD_GUIDE = `# Building a custom theme

You will help the person make a custom theme. A theme changes the app's color, font, corners,
logo, the names of things, and how you talk to them. Follow the steps in order. Do one step at
a time. Keep every message short.

## Step 1. Ask for the idea
Call ask_person with the question "What should your theme be about?" and these options:
"Trainer adventure", "Company with a CEO", "Space crew", "Fantasy guild", "Cozy home".
If they already said what they want, skip this step.

## Step 2. Ask for the feeling
Call ask_person with the question "How should it feel?" and these options:
"Fun", "Calm", "Professional", "Bold".

## Step 3. Pick the names
Pick a short name (1 to 3 words) for each of these, to fit the idea:
${wordList}
Show the names to the person as a short list. Ask "Do these names work?" with ask_person,
options "Yes", "Make them more fun", "Make them more serious". Change them if asked.

## Step 4. Pick the color
Call ask_person with the question "Which color?" and 4 options that fit the idea. Write each
option as a name and a hex code, like "Ember red #dc2626". Use the hex code they pick.

## Step 5. Pick the style yourself
Do not ask. Choose one of each:
- neutral (the gray color): ${THEME_NEUTRALS.join(", ")}. Use "stone" for warm, "slate" for cool.
- font: ${THEME_FONTS.join(", ")}. Use "rounded" for fun, "serif" for classic or cozy, "mono" for
  techy or retro, "system" otherwise.
- corners: ${THEME_CORNERS.join(", ")}. Use "round" for fun, "sharp" for business, "soft" otherwise.

## Step 6. Draw a logo (you may skip this)
Write a small SVG icon. Copy this pattern and change the shapes:
<svg viewBox="0 0 64 64" fill="currentColor"><circle cx="32" cy="32" r="22" opacity=".5"/><path d="M32 14 L44 46 L20 46 Z"/></svg>
Rules: only these tags: svg, g, path, circle, ellipse, rect, line, polyline, polygon. Use
fill="currentColor". No text, no images. Keep it simple: 2 to 6 big shapes.
Draw your own symbol. Never copy a real logo or character (for example, no Poké Ball, no
company logos). If drawing is too hard, leave the logo out.

## Step 7. Write the voice
Write 2 to 4 short sentences that tell the AI helpers how to talk in this theme. Mention the
names from step 3. Example: "Talk like a cheerful adventure guide. Call tasks quests. Call the
person Trainer. Keep answers short and clear."

## Step 8. Save
Call save_theme once with everything. Example:
save_theme({
  "name": "Trail Trainers",
  "description": "Train and adventure with your partners",
  "accent": "#dc2626",
  "neutral": "stone",
  "font": "rounded",
  "corners": "round",
  "logo": "<svg viewBox=\\"0 0 64 64\\" fill=\\"currentColor\\">...</svg>",
  "words": { "appName": "Trailmate", "captain": "Professor", "crew": "Team",
             "crewMember": "partner", "bridge": "Basecamp", "watches": "Daily Quests",
             "shipyard": "Workshop" },
  "voice": "Talk like a cheerful adventure guide. Call tasks quests. Keep answers short."
})
save_theme always saves. If it says it changed or skipped something, tell the person in one
short sentence.

## Step 9. Finish
Tell the person: "Tap Try it on the card to use it." Ask if they want changes. To change the
theme, call save_theme again with the same id and the full theme.
To switch them to a theme or back to normal, call use_theme. Only rename the AI helpers
themselves (with edit_crew_member) if the person asks, because that changes them for everyone.
`;
