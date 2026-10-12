import type { StarterCrewDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  GUIDE_STEPS,
  nextStep,
  previousStep,
  rankStarters,
  stepPosition,
  stepState,
} from "./onboarding.js";

describe("setup guide steps", () => {
  it("walks forward to the tour and stops there", () => {
    expect(GUIDE_STEPS[0]?.id).toBe("account");
    expect(nextStep("account")).toBe("purpose");
    expect(nextStep("purpose")).toBe("model");
    expect(nextStep("shipyard")).toBe("finish");
    expect(nextStep("finish")).toBe("finish");
  });

  it("never goes back to the account step", () => {
    expect(previousStep("purpose")).toBeNull();
    expect(previousStep("model")).toBe("purpose");
    expect(previousStep("captain")).toBe("model");
    expect(previousStep("finish")).toBe("shipyard");
  });

  it("numbers steps with the account as step 1 of 8", () => {
    expect(stepPosition("account")).toEqual({ n: 1, of: 8 });
    expect(stepPosition("purpose")).toEqual({ n: 2, of: 8 });
    expect(stepPosition("shipyard")).toEqual({ n: 8, of: 8 });
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

describe("rankStarters", () => {
  const starter = (slug: string, uses: Array<"home" | "work">) =>
    ({ slug, uses }) as unknown as StarterCrewDto;
  const all = [
    starter("galley", ["home"]),
    starter("yeoman", ["work"]),
    starter("lookout", ["work", "home"]),
  ];
  const slugs = (r: ReturnType<typeof rankStarters>) => ({
    suggested: r.suggested.map((s) => s.slug),
    others: r.others.map((s) => s.slug),
  });

  it("suggests only the crew that suit the answer", () => {
    expect(slugs(rankStarters(all, "work"))).toEqual({
      suggested: ["yeoman", "lookout"],
      others: ["galley"],
    });
    expect(slugs(rankStarters(all, "home"))).toEqual({
      suggested: ["galley", "lookout"],
      others: ["yeoman"],
    });
  });

  it("suggests everyone for both, or when the question was skipped", () => {
    for (const use of ["both", "", undefined] as const) {
      expect(rankStarters(all, use).others).toEqual([]);
    }
  });
});
