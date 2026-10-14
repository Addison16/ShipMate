import type {
  OnboardingDto,
  OnboardingStep,
  ShipmateUse,
  StarterCrewDto,
  ThemeWordMap,
} from "@shipmate/core";

export interface GuideStep {
  id: OnboardingStep;
  /** Short name for the progress rail. */
  label: string;
  /** Can be passed over with Skip. */
  optional: boolean;
}

/** The owner's first-launch guide, in order (mirrors ONBOARDING_STEPS on the server). */
export const GUIDE_STEPS: GuideStep[] = [
  { id: "account", label: "Owner account", optional: false },
  { id: "purpose", label: "What it's for", optional: true },
  { id: "style", label: "Style", optional: true },
  { id: "model", label: "AI model", optional: true },
  { id: "captain", label: "Your Captain", optional: true },
  { id: "household", label: "About you", optional: true },
  { id: "crew", label: "Starter crew", optional: true },
  { id: "connect", label: "Stay in touch", optional: true },
  { id: "shipyard", label: "Shipyard", optional: true },
  { id: "finish", label: "Tour", optional: false },
];

/** A step's label in the words of the person's style or theme ("Your Assistant", "Your CEO"). */
export function stepLabel(step: GuideStep, words: ThemeWordMap): string {
  if (step.id === "captain") return `Your ${words.captain}`;
  if (step.id === "crew") return `Starter ${words.crew.toLowerCase()}`;
  if (step.id === "shipyard") return words.shipyard;
  return step.label;
}

const index = (step: OnboardingStep) => GUIDE_STEPS.findIndex((s) => s.id === step);

export function nextStep(step: OnboardingStep): OnboardingStep {
  return GUIDE_STEPS[Math.min(index(step) + 1, GUIDE_STEPS.length - 1)]?.id ?? "finish";
}

/** The step before, or null on the first step after the account (it cannot be redone). */
export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const i = index(step);
  return i <= 1 ? null : (GUIDE_STEPS[i - 1]?.id ?? null);
}

/** "Step 2 of 8": the account counts as step 1 and the closing tour is not numbered. */
export function stepPosition(step: OnboardingStep): { n: number; of: number } {
  return { n: Math.max(1, index(step) + 1), of: GUIDE_STEPS.length - 1 };
}

export type StepState = "done" | "skipped" | "current" | "todo";

export function stepState(
  step: OnboardingStep,
  current: OnboardingStep,
  progress: Pick<OnboardingDto, "done" | "skipped"> | null,
): StepState {
  if (step === current) return "current";
  if (step === "account" || progress?.done.includes(step)) return "done";
  if (progress?.skipped.includes(step)) return "skipped";
  return "todo";
}

/** Where the closing tour sends people. */
export interface TourStop {
  path: string;
  title: string;
  body: string;
  icon: "bridge" | "lists" | "watches" | "shipyard" | "crew" | "settings" | "bridges";
}

/** The tour, in the words of the person's style or theme. */
export function tourStops(w: ThemeWordMap): TourStop[] {
  const crew = w.crew.toLowerCase();
  return [
    {
      path: "/bridge",
      title: w.bridge,
      body: `Chat with your ${w.captain}. Ask anything; it hands recurring work to the right ${w.crewMember}.`,
      icon: "bridge",
    },
    {
      path: "/lists",
      title: "Lists",
      body: `Groceries, chores and bills the whole household shares, kept up to date by your ${crew}.`,
      icon: "lists",
    },
    {
      path: "/watches",
      title: w.watches,
      body: "Routines on a schedule: a morning briefing, a weekly meal plan, bill reminders.",
      icon: "watches",
    },
    {
      path: "/crew",
      title: w.crew,
      body: `Everyone on your team and what they do. Edit one, add new ${crew}, or retire one.`,
      icon: "crew",
    },
    {
      path: "/shipyard",
      title: w.shipyard,
      body: `Point one of your ${crew} at a GitHub repo to plan features, fix issues and review PRs.`,
      icon: "shipyard",
    },
    {
      path: "/bridges",
      title: "Chat apps",
      body: `Talk to your ${crew} from Discord, Telegram or Slack.`,
      icon: "bridges",
    },
    {
      path: "/settings",
      title: "Settings",
      body: "Your profile, notifications, theme and, for owners, this guide again.",
      icon: "settings",
    },
  ];
}

/** The answers to "What's Shipmate for?", the first question of the guide. */
export const USE_CHOICES: Array<{ id: ShipmateUse; title: string; body: string }> = [
  {
    id: "home",
    title: "Home life",
    body: "Meals, bills, the family calendar, homework and trips.",
  },
  {
    id: "work",
    title: "Work",
    body: "Your to-do list, email drafts, meeting prep and research.",
  },
  {
    id: "both",
    title: "Both",
    body: "A bit of each. You get suggestions for home and for work.",
  },
];

/**
 * Starter crew in the order the picker shows them: the ones that suit `use` first (and
 * suggested), then the rest. With no answer, everything counts as a match.
 */
export function rankStarters(
  starters: StarterCrewDto[],
  use: ShipmateUse | "" | undefined,
): { suggested: StarterCrewDto[]; others: StarterCrewDto[] } {
  const fits = (s: StarterCrewDto) => !use || use === "both" || s.uses.includes(use);
  // Crew made just for this use lead, then the ones that suit both.
  const suggested = starters.filter(fits).sort((a, b) => a.uses.length - b.uses.length);
  return { suggested, others: starters.filter((s) => !fits(s)) };
}
