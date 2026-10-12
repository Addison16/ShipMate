import { describe, expect, it } from "vitest";
import {
  applyOnboardingUpdate,
  CAPTAIN_VOICES,
  freshOnboarding,
  matchVoice,
  parseOnboarding,
  voiceSection,
  withVoiceSection,
} from "./onboarding.js";

describe("parseOnboarding", () => {
  it("treats a missing state as finished so upgrades skip the guide", () => {
    expect(parseOnboarding(null).pending).toBe(false);
    expect(parseOnboarding(undefined).pending).toBe(false);
  });

  it("is pending until completedAt is set and repairs bad values", () => {
    expect(parseOnboarding(freshOnboarding())).toEqual({
      step: "purpose",
      done: ["account"],
      skipped: [],
      completedAt: null,
      pending: true,
    });
    expect(parseOnboarding({ step: "nowhere", done: "x", completedAt: null })).toMatchObject({
      step: "purpose",
      done: [],
      pending: true,
    });
  });
});

describe("applyOnboardingUpdate", () => {
  const now = new Date("2026-10-12T10:00:00.000Z");

  it("moves, marks done and skipped without duplicates", () => {
    let s = freshOnboarding();
    s = applyOnboardingUpdate(s, { step: "captain", skipped: "model" });
    s = applyOnboardingUpdate(s, { step: "household", done: "captain" });
    s = applyOnboardingUpdate(s, { done: "captain" });
    expect(s).toMatchObject({
      step: "household",
      done: ["account", "captain"],
      skipped: ["model"],
    });
    // Coming back and finishing a skipped step moves it to done.
    s = applyOnboardingUpdate(s, { done: "model" });
    expect(s.skipped).toEqual([]);
    expect(s.done).toContain("model");
    // A finished step is never also marked skipped.
    expect(applyOnboardingUpdate(s, { skipped: "model" }).skipped).toEqual([]);
  });

  it("never goes back to the account step", () => {
    expect(applyOnboardingUpdate(freshOnboarding(), { step: "account" }).step).toBe("purpose");
  });

  it("finishes and restarts", () => {
    const done = applyOnboardingUpdate(freshOnboarding(), { finish: true }, now);
    expect(done).toMatchObject({ step: "finish", completedAt: now.toISOString() });
    expect(parseOnboarding(done).pending).toBe(false);
    const again = applyOnboardingUpdate(done, { restart: true });
    expect(again).toEqual(freshOnboarding());
  });
});

describe("Captain voice", () => {
  const persona = "# Captain\n\nIntro.\n\n## Always\n\n- Be kind.\n\n## Voice\n\nPlain, warm.\n";

  it("reads and replaces the Voice section", () => {
    expect(voiceSection(persona)).toBe("Plain, warm.");
    const next = withVoiceSection(persona, "Terse.");
    expect(next).toBe("# Captain\n\nIntro.\n\n## Always\n\n- Be kind.\n\n## Voice\n\nTerse.\n");
    expect(voiceSection(next)).toBe("Terse.");
  });

  it("keeps sections after Voice and appends one when missing", () => {
    const middle = "# A\n\n## Voice\n\nOld.\n\n## Never\n\n- Lie.\n";
    expect(withVoiceSection(middle, "New.")).toBe(
      "# A\n\n## Voice\n\nNew.\n\n## Never\n\n- Lie.\n",
    );
    expect(withVoiceSection("# A\n\nBody.\n", "Hi.")).toBe("# A\n\nBody.\n\n## Voice\n\nHi.\n");
    expect(voiceSection("# A\n")).toBe("");
  });

  it("matches presets ignoring line wrapping", () => {
    const steady = CAPTAIN_VOICES[0];
    expect(steady?.id).toBe("steady");
    expect(matchVoice((steady?.text ?? "").replace(/\n/g, " "))).toBe("steady");
    expect(matchVoice("Speak only in haiku.")).toBe("custom");
  });
});
