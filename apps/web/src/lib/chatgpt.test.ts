import { describe, expect, it } from "vitest";
import { callbackProblem, planLabel } from "./chatgpt.js";

describe("chatgpt helpers", () => {
  it("accepts a callback address and explains common mistakes", () => {
    expect(
      callbackProblem("http://127.0.0.1:1455/auth/callback?code=a&state=b&client_id=c"),
    ).toBeNull();
    expect(callbackProblem("code=a&state=b")).toBeNull();
    expect(callbackProblem("")).toMatch(/Paste/);
    expect(callbackProblem("https://auth.openai.com/api/accounts/authorize?x=1")).toMatch(
      /sign-in link/,
    );
    expect(callbackProblem("http://127.0.0.1:1455/auth/callback?state=b")).toMatch(
      /no sign-in code/,
    );
    expect(callbackProblem("http://127.0.0.1:1455/auth/callback?error=access_denied")).toMatch(
      /access_denied/,
    );
  });

  it("formats plan names", () => {
    expect(planLabel("plus")).toBe("Plus");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("team_plan")).toBe("Team Plan");
    expect(planLabel(null)).toBeNull();
  });
});
