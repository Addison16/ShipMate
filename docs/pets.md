# Crew pets

Pets are optional. A crew member with a pet gets a small creature that sits on the message box
in chat, dances while that crew member is working on a reply, and does a happy hop when the
reply lands. Tap it to say hi. Pets also hang out on the Crew page. They keep still when your
phone or computer asks for reduced motion.

## Making one

Open a crew member, go to **Settings**, and tap **Make a pet with Captain** (or just ask the
Captain on the Bridge, for example "make Galley a pet"). The Captain follows a short written
guide (the `pet_guide` tool) that small self-hosted models can follow too:

1. Who gets the pet.
2. What creature (four ideas that fit the job, or your own).
3. Which style: cute and round, pixel art, cozy storybook or bold cartoon.
4. A name.
5. The Captain writes a one-sentence look and makes the pet (`make_pet`).
6. You see it in the chat and tap **Keep it**, **Try again** or **Change something**.

Pets are always original creatures. Ask for a Pokémon and you get an original creature in that
spirit, not a copy. Only owners and admins can make, hide or show pets, since the crew is
shared.

To hide a pet, untick **Show** on the crew member's Settings tab (or ask the Captain). The
picture is kept, so it can come back.

## Where pictures come from

Owners pick this under **Settings → Photos and voice → Crew pets**:

| Choice | What happens |
| --- | --- |
| The Captain draws them (default) | The chat model draws the pet as a simple SVG. No setup, works with any model. |
| ChatGPT plan | Asks OpenAI's public Responses API for a picture with your Sign in with ChatGPT login. OpenAI documents that sign-in for chat, not pictures, so this only works if OpenAI allows it for your plan. If it refuses, the Captain draws the pet instead. Shipmate never calls ChatGPT's private endpoints. |
| A provider | Uses an OpenAI or OpenAI-compatible provider's `/images/generations` and key. With OpenAI the default model is `gpt-image-1` (a few cents a picture). |
| An image server | Any OpenAI-style `/images/generations` server, such as [LocalAI](https://localai.io) running Stable Diffusion on your own hardware. Optional API key. |

If a picture fails for any reason, the Captain is told why and draws the pet itself.

Image models are asked for a sticker-style character on a plain background. Shipmate clears a
plain background so the pet stands on its own, and stores it small (384 pixels) so it loads fast
on phones.

## On disk

A pet lives in the crew member's folder:

```yaml
# /data/crew/galley/crew.yaml
pet:
  enabled: true
  name: Biscuit
  look: a round sea otter chef in brown and cream with a tiny chef's hat, cute and round style
  image: pet.png
```

The picture is `/data/crew/galley/pet/pet.png` (or `.svg`), and drafts from builds are kept in
`pet/drafts/` (the last 12). Drawn SVGs are checked before they are saved: only plain shapes and
gradients, no scripts, links, styles, text or embedded pictures. Pets are left out of crew
export files.
