import type { OnboardingDto, OnboardingStep } from "@shipmate/core";

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
  { id: "model", label: "AI model", optional: true },
  { id: "captain", label: "Your Captain", optional: true },
  { id: "household", label: "Home", optional: true },
  { id: "crew", label: "Starter crew", optional: true },
  { id: "connect", label: "Stay in touch", optional: true },
  { id: "shipyard", label: "Shipyard", optional: true },
  { id: "finish", label: "Tour", optional: false },
];

const index = (step: OnboardingStep) => GUIDE_STEPS.findIndex((s) => s.id === step);

export function nextStep(step: OnboardingStep): OnboardingStep {
  return GUIDE_STEPS[Math.min(index(step) + 1, GUIDE_STEPS.length - 1)]?.id ?? "finish";
}

/** The step before, or null on the first step after the account (it cannot be redone). */
export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const i = index(step);
  return i <= 1 ? null : (GUIDE_STEPS[i - 1]?.id ?? null);
}

/** "Step 2 of 7": the account counts as step 1 and the closing tour is not numbered. */
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

export const TOUR_STOPS: TourStop[] = [
  {
    path: "/bridge",
    title: "Bridge",
    body: "Chat with your Captain. Ask anything; it hands recurring work to the right crew member.",
    icon: "bridge",
  },
  {
    path: "/lists",
    title: "Lists",
    body: "Groceries, chores and bills the whole household shares, kept up to date by the crew.",
    icon: "lists",
  },
  {
    path: "/watches",
    title: "Watches",
    body: "Routines on a schedule: a morning briefing, a weekly meal plan, bill reminders.",
    icon: "watches",
  },
  {
    path: "/crew",
    title: "Crew",
    body: "Everyone aboard and what they do. Edit a persona, recruit new crew, or retire one.",
    icon: "crew",
  },
  {
    path: "/shipyard",
    title: "Shipyard",
    body: "Point a crew member at a GitHub repo to plan features, fix issues and review PRs.",
    icon: "shipyard",
  },
  {
    path: "/bridges",
    title: "Chat bridges",
    body: "Talk to the crew from Discord, Telegram or Slack.",
    icon: "bridges",
  },
  {
    path: "/settings",
    title: "Settings",
    body: "Your profile, notifications, theme and, for owners, this guide again.",
    icon: "settings",
  },
];
