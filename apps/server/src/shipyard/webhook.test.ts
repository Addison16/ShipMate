import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { routeOf, sandboxSpec, summarizeEvent, verifySignature } from "./service.js";

const sign = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("GitHub webhook signatures", () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome." });
  it("accepts the right HMAC over the raw body", () => {
    expect(verifySignature("s3cret", Buffer.from(body), sign("s3cret", body))).toBe(true);
  });
  it("rejects a wrong secret, a changed body, a missing or malformed header", () => {
    expect(verifySignature("s3cret", Buffer.from(body), sign("other", body))).toBe(false);
    expect(verifySignature("s3cret", Buffer.from(`${body} `), sign("s3cret", body))).toBe(false);
    expect(verifySignature("s3cret", Buffer.from(body), undefined)).toBe(false);
    expect(verifySignature("s3cret", Buffer.from(body), "sha1=abc")).toBe(false);
    expect(verifySignature("s3cret", Buffer.from(body), "sha256=abc")).toBe(false);
  });
});

describe("webhook routing", () => {
  it("routes failed checks, reviews and PR comments to the PR", () => {
    expect(
      routeOf("check_suite", {
        action: "completed",
        check_suite: { conclusion: "failure", pull_requests: [{ number: 7 }] },
      }),
    ).toEqual({ number: 7 });
    expect(
      routeOf("check_suite", {
        action: "completed",
        check_suite: { conclusion: "success", pull_requests: [{ number: 7 }] },
      }),
    ).toBeNull();
    expect(
      routeOf("check_run", {
        action: "completed",
        check_run: { conclusion: "timed_out", pull_requests: [{ number: 8 }] },
      }),
    ).toEqual({ number: 8 });
    expect(
      routeOf("pull_request_review", {
        action: "submitted",
        review: { body: "please rename" },
        pull_request: { number: 9 },
      }),
    ).toEqual({ number: 9 });
    expect(
      routeOf("issue_comment", {
        action: "created",
        issue: { number: 10, pull_request: {} },
        comment: { body: "lgtm?" },
      }),
    ).toEqual({ number: 10 });
  });
  it("ignores issue comments and Shipmate's own comments", () => {
    expect(
      routeOf("issue_comment", { action: "created", issue: { number: 3 }, comment: { body: "x" } }),
    ).toBeNull();
    expect(
      routeOf("issue_comment", {
        action: "created",
        issue: { number: 10, pull_request: {} },
        comment: { body: "Done.\n\n_— Shipwright on Shipmate_" },
      }),
    ).toBeNull();
    expect(routeOf("push", { ref: "refs/heads/main" })).toBeNull();
  });
  it("summarizes in one line", () => {
    expect(
      summarizeEvent("pull_request", {
        action: "closed",
        pull_request: { number: 4, title: "Fix it", merged: true },
        sender: { login: "addison" },
      }),
    ).toBe("PR #4 merged: Fix it by addison");
    expect(summarizeEvent("ping", {})).toBe("GitHub webhook connected");
  });
});

describe("sandbox container spec", () => {
  it("mounts only the workspace, sets no Shipmate env and no Docker socket", () => {
    const spec = sandboxSpec("p1", "node:22-bookworm", "/srv/data/workspaces/app");
    expect(spec.HostConfig.Binds).toEqual(["/srv/data/workspaces/app:/workspace"]);
    expect(spec.Labels).toEqual({ "shipmate.project": "p1" });
    expect(spec.Cmd).toEqual(["sleep", "infinity"]);
    expect(JSON.stringify(spec)).not.toContain("docker.sock");
    expect(spec.Env.join(" ")).not.toMatch(/SHIPMATE|TOKEN|SECRET|DATABASE/);
  });
});
