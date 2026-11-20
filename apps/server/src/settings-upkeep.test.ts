import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("restore from Settings and memory editing", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let member = "";
  let restarts = 0;
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
    cookie = owner,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  beforeAll(async () => {
    t = await testApp(db as string, { restart: () => restarts++ });
    owner = cookieOf(
      await t.app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { email: "owner@example.com", displayName: "Owner", password: "correct horse" },
      }),
    );
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    member = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("adds, changes and lists a memory; shared ones need an admin", async () => {
    const url = "/api/crew/captain/memory/user/sam-is-vegetarian";
    const added = await api("PUT", url, { description: "Sam is vegetarian", body: "No meat." });
    expect(added.statusCode).toBe(200);
    const changed = await api("PUT", url, {
      description: "Sam is vegetarian",
      body: "No meat or fish.",
    });
    expect(changed.json().memory).toMatchObject({
      name: "sam-is-vegetarian",
      scope: "user",
      body: "No meat or fish.",
    });
    const mine = (await api("GET", "/api/crew/captain/memory")).json().mine;
    expect(mine).toHaveLength(1);
    // Someone else does not see it, and cannot write shared memory.
    expect((await api("GET", "/api/crew/captain/memory", undefined, member)).json().mine).toEqual(
      [],
    );
    const shared = "/api/crew/captain/memory/shared/bins-on-tuesday";
    const text = { description: "Bins go out on Tuesday", body: "Before 7am." };
    expect((await api("PUT", shared, text, member)).statusCode).toBe(403);
    expect((await api("PUT", shared, text)).statusCode).toBe(200);
    expect(
      (await api("PUT", "/api/crew/captain/memory/user/Not%20A%20Slug", text)).statusCode,
    ).toBe(400);
    expect((await api("PUT", url, { description: "", body: "x" })).statusCode).toBe(400);
  });

  it("restores a backup after a typed confirmation, keeping a safety backup", async () => {
    const { backup } = (await api("POST", "/api/backups")).json();
    // Something made after the backup, which the restore takes away again.
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const restoreUrl = `/api/backups/${backup.name}/restore`;

    expect((await api("POST", restoreUrl, { confirm: "RESTORE" }, member)).statusCode).toBe(403);
    expect((await api("POST", restoreUrl, { confirm: "yes" })).statusCode).toBe(400);
    expect(
      (await api("POST", "/api/backups/nope.tar.gz/restore", { confirm: "RESTORE" })).statusCode,
    ).toBe(404);
    expect(restarts).toBe(0);

    const done = await api("POST", restoreUrl, { confirm: "restore" });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ ok: true, restarting: true });
    const safety = done.json().safety.name as string;
    expect(safety).not.toBe(backup.name);

    // The owner's sign-in was in the backup, so it still works; the later chat is gone.
    const ids = (await api("GET", "/api/conversations"))
      .json()
      .conversations.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(conv.id);
    const names = (await api("GET", "/api/backups"))
      .json()
      .backups.map((b: { name: string }) => b.name);
    expect(names).toEqual(expect.arrayContaining([backup.name, safety]));
    // A second restore is refused while the restart is pending.
    expect((await api("POST", restoreUrl, { confirm: "RESTORE" })).statusCode).toBe(409);
    await new Promise((r) => setTimeout(r, 1700));
    expect(restarts).toBe(1);
  });
});
