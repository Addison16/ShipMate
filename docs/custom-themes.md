# Custom themes

Shipmate doesn't have to be nautical. In **Settings > Appearance > Make a custom theme**, your
Captain walks you through building a theme of your own: colors, grays, font, corners, an
original logo, the app's words (Bridge, Crew, Captain...) and how the crew talks to you. A
preview card appears in the chat with a **Try it** button.

- Each person picks their own theme; everyone can use any theme saved on the instance.
- The crew uses a theme's words and voice only with the person using it.
- Pick any color theme to go back to the standard look.
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

Every field except `name` and `accent` is optional. Outside Shipmate, skip the tool names in
the guide: ask the questions in plain chat and write the file at the end.

## The build guide

The Captain reads this with its `theme_build_guide` tool.

A custom theme changes how Shipmate looks and talks for the person using it: colors, grays,
font, corners, logo, the app's words, and the crew's voice. It is not limited to ships: a
trainer adventure, a company with a CEO, a space station, a cozy cottage, anything.

Work through the steps in order, one question at a time. Use `ask_person` with 3 to 5 short
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
  - `appName`: the app's name in the header and tab (default "Shipmate")
  - `captain`: the coordinator who leads the crew (title) (default "Captain")
  - `crew`: the team of AI helpers (page name) (default "Crew")
  - `crewMember`: one helper, lowercase singular (default "crew member")
  - `bridge`: where you chat (page name) (default "Bridge")
  - `watches`: scheduled jobs and briefings (page name) (default "Watches")
  - `shipyard`: GitHub and work projects (page name) (default "Shipyard")
Words are short (1 to 3 words, at most 24 characters). Page names are capitalized; `crewMember`
is lowercase. Example for a company: captain "CEO", crew "Team", crewMember "team member",
bridge "Office", watches "Schedule", shipyard "Projects", appName "HQ".

## 4. Colors and style
Offer 3 or 4 accent colors that fit, each as a name plus hex (for example "Ember red #dc2626").
Then pick, or ask about:
- `neutral`, the grays for pages and text: slate, gray, zinc, neutral, stone, tinted ("tinted" takes a
  hint of the accent; "stone" is warm; "slate" is cool, the default).
- `font`: system, rounded, serif, mono.
- `corners`: sharp, soft, round.
Any accent works: Shipmate works out the light and dark shades itself and keeps text readable.

## 5. The logo
Draw an original, simple, bold mark as an SVG:
- One `<svg>` with `viewBox="0 0 64 64"`, shapes only: g, path, circle, ellipse, rect, line,
  polyline, polygon, and gradients, clipPath or mask in defs.
- Draw in `currentColor` (or white) on a transparent background: it is shown in white on a
  rounded tile of the accent color. Use `opacity` for depth. Keep it readable at 20 pixels:
  a few large shapes, no fine detail, no text.
- No style or class attributes, scripts, images, links or text elements.
- Make it your own. Never copy a logo, mascot or character from a brand or franchise (no
  Poké Balls, no company logos): draw something new that evokes the idea, such as an original
  creature, emblem, badge, or symbol.

## 6. The voice
Write 3 to 6 sentences, as instructions to the crew, on how to talk with this person: tone,
a few signature phrases, and to use the theme's words (the coordinator is the `captain` word,
the team is the `crew` word). Flavor only: stay clear, accurate and helpful, keep answers
as short as before, drop the flavor for serious, sensitive or urgent topics, and never claim
to be a real person or a trademarked character.

## 7. Save and preview
Call `save_theme` with everything. If it reports problems, fix them all and call it again
(pass the same `id` once you have one). The person then sees a preview card in the chat with
a Try it button. Ask whether they want any changes, and save again with the same `id` for
each change; nothing about the theme needs to start over.

## 8. Wrap up
- They can switch any time in Settings > Appearance, including back to the standard Shipmate
  look; `use_theme` switches for them if they ask in chat.
- The crew's own names (the coordinator's name included) are shared by everyone. Only if the
  person is an owner or admin and asks, offer to rename crew members to fit with
  `edit_crew_member`, after saying it changes the names for everyone.
