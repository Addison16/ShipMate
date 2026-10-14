import { z } from "zod";

/**
 * The owner's first-launch guide, in order. `account` happens before anyone is signed in; the
 * rest are skippable and each one saves as it goes, so the guide can resume where it stopped.
 */
export const ONBOARDING_STEPS = [
  "account",
  "purpose",
  "style",
  "model",
  "captain",
  "household",
  "crew",
  "connect",
  "shipyard",
  "finish",
] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/** Stored instance-wide under the "onboarding" settings key. */
export const OnboardingState = z.object({
  /** Where the guide resumes. */
  step: OnboardingStep.catch("purpose"),
  /** Steps finished with Next. */
  done: z.array(OnboardingStep).catch([]),
  /** Steps passed over with Skip. */
  skipped: z.array(OnboardingStep).catch([]),
  /** ISO time the owner finished or dismissed the guide; null while it is still running. */
  completedAt: z.string().nullable().catch(null),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

export interface OnboardingDto extends OnboardingState {
  /** True while the owner should see the guide instead of the app. */
  pending: boolean;
}

/**
 * Instances set up before the guide existed have no state; they count as finished so an upgrade
 * never drops the owner back into first-run screens.
 */
export function parseOnboarding(value: unknown): OnboardingDto {
  if (!value || typeof value !== "object") {
    return {
      step: "finish",
      done: [],
      skipped: [],
      completedAt: "1970-01-01T00:00:00.000Z",
      pending: false,
    };
  }
  const state = OnboardingState.parse(value);
  return { ...state, pending: state.completedAt === null };
}

/** The state right after the owner account is created. */
export function freshOnboarding(): OnboardingState {
  return { step: "purpose", done: ["account"], skipped: [], completedAt: null };
}

/**
 * PUT /api/onboarding (owner). `step` moves the guide; `done`/`skipped` mark one step; `finish`
 * closes it; `restart` opens it again from the first step (Settings → Run the setup guide).
 */
export const OnboardingUpdate = z
  .object({
    step: OnboardingStep.optional(),
    done: OnboardingStep.optional(),
    skipped: OnboardingStep.optional(),
    finish: z.boolean().optional(),
    restart: z.boolean().optional(),
  })
  .strict();
export type OnboardingUpdate = z.infer<typeof OnboardingUpdate>;

export function applyOnboardingUpdate(
  state: OnboardingState,
  update: OnboardingUpdate,
  now: Date = new Date(),
): OnboardingState {
  if (update.restart)
    return { ...freshOnboarding(), done: state.done.includes("account") ? ["account"] : [] };
  const next: OnboardingState = { ...state, done: [...state.done], skipped: [...state.skipped] };
  if (update.done) {
    if (!next.done.includes(update.done)) next.done.push(update.done);
    next.skipped = next.skipped.filter((s) => s !== update.done);
  }
  if (
    update.skipped &&
    !next.done.includes(update.skipped) &&
    !next.skipped.includes(update.skipped)
  ) {
    next.skipped.push(update.skipped);
  }
  if (update.step && update.step !== "account") next.step = update.step;
  if (update.finish) {
    next.step = "finish";
    next.completedAt = now.toISOString();
  }
  return next;
}

// ---------- the Captain's voice ----------

export interface CaptainVoice {
  id: string;
  label: string;
  /** One line shown under the label. */
  blurb: string;
  /** A sample reply to "What's for dinner tonight?". */
  sample: string;
  /** A sample reply to "What's on my plate today?", shown when Shipmate is for work. */
  workSample: string;
  /** The `## Voice` section body written into the Captain's CREW.md. */
  text: string;
}

/** Personality presets for the Captain. The first one matches the stock CREW.md. */
export const CAPTAIN_VOICES: CaptainVoice[] = [
  {
    id: "steady",
    label: "Steady hand",
    blurb: "Plain, warm and brief. The default.",
    sample: "Tacos tonight: you have tortillas, beans and peppers. I put cheese on the list.",
    workSample:
      "Three meetings, the first at 10. The budget review needs your slides; I put them on your to-do list.",
    text: "Plain, warm, brief. Lead with the answer. Use the nautical theme lightly; never let it get in\nthe way of being clear.",
  },
  {
    id: "brisk",
    label: "Straight to the point",
    blurb: "Terse and efficient, no small talk.",
    sample: "Tacos. Cheese added to the list.",
    workSample: "3 meetings, first at 10. Budget slides: on your list.",
    text: "Terse and efficient. Lead with the answer in a sentence or a short list; skip greetings,\nrecaps and small talk. No nautical flourishes.",
  },
  {
    id: "cheerful",
    label: "Cheerful first mate",
    blurb: "Upbeat, friendly and encouraging.",
    sample:
      "Taco night! You've got almost everything; I added cheese to the list so you're all set.",
    workSample:
      "Three meetings today, first one at 10! I put the budget slides on your list so you're all set.",
    text: "Upbeat, friendly and encouraging. Lead with the answer, then a short friendly note when it\nhelps. A little nautical humor now and then is welcome; keep it clear.",
  },
  {
    id: "salty",
    label: "Old sea dog",
    blurb: "Salty sayings and dry humor, still clear.",
    sample: "Tacos, matey. The hold's got all but cheese, and that's on the list now.",
    workSample:
      "Three meetings on the horizon, first at 10. Budget slides are on the list, so no getting caught in the doldrums.",
    text: "Talk like a seasoned ship's captain: salty turns of phrase and a dry sense of humor, but\nevery answer still clear and useful. Lead with the answer, and keep the sea talk out of lists,\nnumbers and code.",
  },
  {
    id: "patient",
    label: "Patient teacher",
    blurb: "Calm, explains the why. Good for kids.",
    sample:
      "How about tacos? You have tortillas, beans and peppers already. Cheese was missing, so I added it.",
    workSample:
      "You have three meetings today, starting at 10. The budget review needs slides, so I added them to your to-do list to leave time to prepare.",
    text: "Calm and patient. Lead with the answer, then explain the why in plain words, define any\njargon, and check whether the answer fits. Good for kids and anyone new to this.",
  },
];

const VOICE_HEADING = /^## Voice[ \t]*$/m;

/** The `## Voice` section body of a CREW.md, or "" when it has none. */
export function voiceSection(persona: string): string {
  const match = VOICE_HEADING.exec(persona);
  if (!match) return "";
  const rest = persona.slice(match.index + match[0].length);
  const end = rest.search(/^#{1,2} /m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** CREW.md with its `## Voice` section replaced (or appended when missing). */
export function withVoiceSection(persona: string, voice: string): string {
  const body = voice.trim();
  const match = VOICE_HEADING.exec(persona);
  if (!match) return `${persona.trimEnd()}\n\n## Voice\n\n${body}\n`;
  const head = persona.slice(0, match.index);
  const rest = persona.slice(match.index + match[0].length);
  const end = rest.search(/^#{1,2} /m);
  const tail = end === -1 ? "" : `\n\n${rest.slice(end).trimEnd()}`;
  return `${head}## Voice\n\n${body}${tail}\n`;
}

/** Which preset a voice section is, comparing whitespace-insensitively; "custom" otherwise. */
export function matchVoice(voice: string): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return CAPTAIN_VOICES.find((v) => norm(v.text) === norm(voice))?.id ?? "custom";
}
