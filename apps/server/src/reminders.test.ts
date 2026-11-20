import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("one-time watches (reminders)", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const api = (method: "GET" | "POST" | "PATCH", url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const until = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    t = await testApp(db as string, { watches: true });
    const setup = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Owner", password: "correct horse" },
    });
    cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
  });
  afterAll(async () => {
    await t?.app.close();
  });

  const reminder = (at: string) =>
    api("POST", "/api/watches", {
      name: "Take the bins out",
      crewSlug: "captain",
      prompt: "Remind me to take the bins out.",
      trigger: { kind: "once", at },
    });

  it("refuses a time that has passed, or one that is not a date", async () => {
    const past = await reminder(new Date(Date.now() - 60_000).toISOString());
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toBe("pick a time that is still ahead");
    expect((await reminder("tomorrow at five")).statusCode).toBe(400);
  });

  it("runs once at its time, then turns itself off", async () => {
    t.faux.setResponses([fauxAssistantMessage("Bins!")]);
    const at = new Date(Date.now() + 700).toISOString();
    const created = await reminder(at);
    expect(created.statusCode).toBe(200);
    const { watch } = created.json();
    expect(watch.trigger).toEqual({ kind: "once", at });
    expect(watch.nextRunAt).toBe(at);

    await until(async () => {
      const runs = (await api("GET", `/api/watches/${watch.id}/runs`)).json().runs;
      return runs.length === 1 && runs[0].status !== "running";
    });
    const [run] = (await api("GET", `/api/watches/${watch.id}/runs`)).json().runs;
    expect(run).toMatchObject({ status: "succeeded", cause: "schedule" });
    const after = (await api("GET", `/api/watches/${watch.id}`)).json().watch;
    expect(after.enabled).toBe(false);

    // Nothing more runs later.
    await new Promise((r) => setTimeout(r, 400));
    expect((await api("GET", `/api/watches/${watch.id}/runs`)).json().runs).toHaveLength(1);
  });
});
