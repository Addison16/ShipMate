import { describe, expect, it } from "vitest";
import { parseApprovalReply } from "./relay.js";

describe("typed approval answers", () => {
  it("reads approve, deny and always in plain words", () => {
    for (const t of [
      "approve",
      "Approve!",
      "allow",
      "yes",
      "Y",
      "ok",
      "OK.",
      "go ahead",
      "👍",
      "/approve",
    ]) {
      expect(parseApprovalReply(t)).toBe("allow");
    }
    for (const t of ["deny", "Denied", "no", "No!", "reject", "decline", "👎", "!deny"]) {
      expect(parseApprovalReply(t)).toBe("deny");
    }
    expect(parseApprovalReply("always allow")).toBe("always");
    expect(parseApprovalReply("always")).toBe("always");
  });

  it("leaves anything else for the crew", () => {
    for (const t of ["yes please run it twice", "no idea", "approve the PR", "", "okay so"]) {
      expect(parseApprovalReply(t)).toBeNull();
    }
  });
});
