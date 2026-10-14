# Custom themes

Shipmate uses plain AI words out of the box (Assistant, Agents, Chat, Routines, Projects).
Each person can switch to the **Nautical** words (Captain, Crew, Bridge, Watches, Shipyard) in
**Settings > Appearance > Words**, or have their AI build a whole theme of their own. The setup
guide asks about this too (the **Style** step).

In **Settings > Appearance > Make a custom theme**, your Assistant walks you through building a
theme: colors, grays, font, corners, an original logo, the app's words and how the AI talks to
you. A preview card appears in the chat with a **Try it** button.

- Each person picks their own theme; everyone can use any theme saved on the instance.
- The AI uses a theme's words and voice only with the person using it.
- Pick a color theme, or Plain or Nautical words, to go back to the standard look.
- Themes download and import as `.shipmate-theme.json` files, so you can also build one with
  another AI by giving it the guide below, then import the file it writes.
- Shipmate works out the light and dark shades from one accent color and keeps text readable
  (WCAG AA). Logos are checked: plain vector shapes only, shown as images.
- Phone home-screen icons keep the color theme's icon (they need PNG files); the browser tab
  icon follows the custom theme.

## The file

```json
{
  "shipmate": "theme",
  "version": 1,
  "name": "Head Office",
  "description": "A company with a CEO",
  "accent": "#2563eb",
  "neutral": "gray",
  "font": "system",
  "corners": "sharp",
  "logo": "<svg viewBox=\"0 0 64 64\" fill=\"currentColor\">...</svg>",
  "words": { "appName": "HQ", "captain": "CEO", "crew": "Team", "crewMember": "team member",
             "bridge": "Office", "watches": "Schedule", "shipyard": "Projects" },
  "voice": "Talk like a sharp, upbeat chief of staff..."
}
```

Every field is optional; a missing name or color gets a default. Outside Shipmate, skip the tool names in
the guide: ask the questions in plain chat and write the file at the end.

## The build guide

The AI reads this with its `theme_build_guide` tool. It is written in short steps so small
local models can follow it. `save_theme` always saves: it fixes what it can (a color name
becomes a hex code, a broken logo is left out) and says what it changed.

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
- appName: the app's name. Normal: "Shipmate".
- captain: the main AI that leads the others. Normal: "Assistant".
- crew: the group of AI helpers (page name). Normal: "Agents".
- crewMember: one AI helper, lowercase. Normal: "agent".
- bridge: the chat page. Normal: "Chat".
- watches: scheduled jobs (page name). Normal: "Routines".
- shipyard: GitHub work projects (page name). Normal: "Projects".
Show the names to the person as a short list. Ask "Do these names work?" with ask_person,
options "Yes", "Make them more fun", "Make them more serious". Change them if asked.

## Step 4. Pick the color
Call ask_person with the question "Which color?" and 4 options that fit the idea. Write each
option as a name and a hex code, like "Ember red #dc2626". Use the hex code they pick.

## Step 5. Pick the style yourself
Do not ask. Choose one of each:
- neutral (the gray color): slate, gray, zinc, neutral, stone, tinted. Use "stone" for warm, "slate" for cool.
- font: system, rounded, serif, mono. Use "rounded" for fun, "serif" for classic or cozy, "mono" for
  techy or retro, "system" otherwise.
- corners: sharp, soft, round. Use "round" for fun, "sharp" for business, "soft" otherwise.

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
  "logo": "<svg viewBox=\"0 0 64 64\" fill=\"currentColor\">...</svg>",
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
