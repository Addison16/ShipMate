import { describe, expect, it } from "vitest";
import { GUIDE_STEPS, nextStep, previousStep, stepPosition, stepState } from "./onboarding.js";

describe("setup guide steps", () => {
  it("walks forward to the tour and stops there", () => {
    expect(GUIDE_STEPS[0]?.id).toBe("account");
    expect(nextStep("account")).toBe("model");
    expect(nextStep("shipyard")).toBe("finish");
    expect(nextStep("finish")).toBe("finish");
  });

  it("never goes back to the account step", () => {
    expect(previousStep("model")).toBeNull();
    expect(previousStep("captain")).toBe("model");
    expect(previousStep("finish")).toBe("shipyard");
  });

  it("numbers steps with the account as step 1 of 7", () => {
    expect(stepPosition("account")).toEqual({ n: 1, of: 7 });
    expect(stepPosition("model")).toEqual({ n: 2, of: 7 });
    expect(stepPosition("shipyard")).toEqual({ n: 7, of: 7 });
  });

  it("shows done, skipped, current and todo", () => {
    const progress = {
      done: ["account" as const, "model" as const],
      skipped: ["captain" as const],
    };
    expect(stepState("model", "household", progress)).toBe("done");
    expect(stepState("captain", "household", progress)).toBe("skipped");
    expect(stepState("household", "household", progress)).toBe("current");
    expect(stepState("crew", "household", progress)).toBe("todo");
    // The account always counts as done once the guide is running.
    expect(stepState("account", "model", null)).toBe("done");
  });
});
