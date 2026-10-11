import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Everyday life: starter crew", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    cookie = ownerCookie,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  beforeAll(async () => {
    t = await testApp(db as string);
    ownerCookie = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("lists the starter packs with their opt-in watches", async () => {
    const { starters } = (await api("GET", "/api/crew/starters")).json();
    const slugs = starters.map((s: { slug: string }) => s.slug).sort();
    expect(slugs).toEqual(["galley", "healthlog", "navigator", "purser", "tutor"]);
    for (const s of starters) {
      expect(s.installed).toBe(false);
      expect(s.watch?.cron).toBeTruthy();
    }
    // Only MCP servers the catalog knows.
    const servers = new Set(
      (await api("GET", "/api/mcp")).json().servers.map((x: { id: string }) => x.id),
    );
    for (const s of starters) for (const id of s.mcp) expect(servers.has(id)).toBe(true);
  });

  it("installs chosen crew on the default model with paused watches", async () => {
    expect(
      (await api("POST", "/api/crew/starters", { slugs: ["galley"] }, memberCookie)).statusCode,
    ).toBe(403);
    expect((await api("POST", "/api/crew/starters", { slugs: ["nope"] })).statusCode).toBe(400);
    expect(
      (await api("POST", "/api/crew/starters", { slugs: ["galley"], timezone: "Mars/Base" }))
        .statusCode,
    ).toBe(400);

    const res = await api("POST", "/api/crew/starters", {
      slugs: ["galley", "navigator"],
      timezone: "America/Chicago",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.crew.map((c: { slug: string }) => c.slug)).toEqual(["galley", "navigator"]);
    for (const c of body.crew) {
      expect(c).toMatchObject({ model: "faux/m", status: "active" });
    }
    expect(body.watches).toHaveLength(2);
    for (const w of body.watches) {
      expect(w.enabled).toBe(false);
      expect(w.trigger).toMatchObject({ kind: "cron", timezone: "America/Chicago" });
    }
    expect(existsSync(join(t.config.dirs.crew, "galley", "CREW.md"))).toBe(true);
    // The template extras stay out of the crew folder.
    expect(existsSync(join(t.config.dirs.crew, "galley", "starter.yaml"))).toBe(false);
    // Catalog servers the Navigator uses are installed for the owner; keys are a follow-up.
    const servers = (await api("GET", "/api/mcp")).json().servers;
    expect(servers.find((x: { id: string }) => x.id === "weather").installed).toBe(true);
    expect(body.notes.join(" ")).toMatch(/Google Workspace needs/);

    // A second install leaves existing crew alone.
    const again = (await api("POST", "/api/crew/starters", { slugs: ["galley"] })).json();
    expect(again.crew).toEqual([]);
    expect(again.notes[0]).toMatch(/already aboard/);
    const listed = (await api("GET", "/api/crew/starters")).json().starters;
    expect(listed.find((s: { slug: string }) => s.slug === "galley").installed).toBe(true);
  });
});
