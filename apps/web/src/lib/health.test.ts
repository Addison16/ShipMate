import type { HealthCheckDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { groupChecks, nextProgress, summarize } from "./health.js";

const c = (id: string, group: string, status: HealthCheckDto["status"]): HealthCheckDto => ({
  id,
  group,
  name: id,
  status,
  detail: "",
  hint: null,
});

describe("health helpers", () => {
  it("summarizes worst first", () => {
    expect(summarize([c("a", "x", "ok")])).toEqual({ status: "ok", label: "All good" });
    expect(summarize([c("a", "x", "warn"), c("b", "x", "ok")]).label).toBe(
      "All working, 1 warning",
    );
    expect(summarize([c("a", "x", "fail"), c("b", "x", "warn"), c("d", "x", "warn")])).toEqual({
      status: "fail",
      label: "1 problem, 2 warnings",
    });
  });

  it("groups in server order", () => {
    const groups = groupChecks([
      c("a", "Database", "ok"),
      c("b", "Models", "ok"),
      c("d", "Database", "ok"),
    ]);
    expect(groups.map(([g, list]) => [g, list.map((x) => x.id)])).toEqual([
      ["Database", ["a", "d"]],
      ["Models", ["b"]],
    ]);
  });

  it("follows an update through the restart", () => {
    const state = { sawDown: false, startedAt: 0 };
    expect(nextProgress(state, { version: "1.0.0" }, "1.0.0", 1000)).toBe("waiting");
    expect(nextProgress(state, null, "1.0.0", 2000)).toBe("restarting");
    expect(nextProgress({ ...state, sawDown: true }, { version: "1.0.0" }, "1.0.0", 3000)).toBe(
      "unchanged",
    );
    expect(nextProgress(state, { version: "1.1.0" }, "1.0.0", 3000)).toBe("updated");
    expect(nextProgress(state, null, "1.0.0", 6 * 60_000)).toBe("timeout");
    expect(nextProgress(state, { version: "1.0.0" }, "1.0.0", 4 * 60_000)).toBe("unchanged");
  });
});
