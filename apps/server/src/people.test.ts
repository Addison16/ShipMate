import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Captain sets people up", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH",
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
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };
  /** One Bridge turn; returns the text of every tool result the model saw. */
  const turn = async (calls: Array<[string, Record<string, unknown>]>, cookie = ownerCookie) => {
    const results: string[] = [];
    // One call per reply so they run in order.
    t.faux.setResponses([
      ...calls.map(([name, args]) => fauxAssistantMessage([fauxToolCall(name, args as never)])),
      (context) => {
        for (const m of context.messages) {
          if (m.role === "toolResult") {
            results.push(m.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
          }
        }
        return fauxAssistantMessage("Done.");
      },
    ]);
    const conv = (await api("POST", "/api/conversations", {}, cookie)).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "set people up" }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    return results;
  };

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
      email: "sam@example.com",
      displayName: "Sam Rivera",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "sam@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    const { crew } = (await api("GET", "/api/crew/captain")).json();
    await api("PUT", "/api/crew/captain", {
      manifestYaml: crew.manifestYaml.replace(/^model: .*$/m, "model: faux/m"),
    });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("lets an owner set up another person, the household and a crew member", async () => {
    const results = await turn([
      [
        "update_person",
        { person: "sam", diet: "vegetarian", timezone: "Europe/Oslo", colorTheme: "coral-reef" },
      ],
      ["update_person", { person: "Sam Rivera", monthlyCapUsd: 20 }],
      ["update_household", { location: "Oslo", notes: "Two adults" }],
      ["edit_crew_member", { slug: "captain", monthlyCapUsd: 50, skills: ["triage"] }],
      ["crew_settings", { slug: "captain" }],
      ["list_people", {}],
    ]);
    expect(results[0]).toContain("Updated Sam Rivera: diet, timezone, theme");
    expect(results[1]).toContain("spending cap");
    expect(results[4]).toContain("monthlyCapUsd: 50");
    expect(results[5]).toContain("Diet: vegetarian");
    expect(results[5]).toContain("cap $20.00/month");
    expect(results[5]).toContain("Home: Oslo");

    const users = (await api("GET", "/api/users")).json().users;
    const sam = users.find((u: { email: string }) => u.email === "sam@example.com");
    expect(sam.monthlyCapCents).toBe(2000);
    const me = (await api("GET", "/api/profile", undefined, memberCookie)).json();
    expect(me.profile.diet).toBe("vegetarian");
    expect(me.household.location).toBe("Oslo");
    const yaml = (await api("GET", "/api/crew/captain")).json().crew.manifestYaml;
    expect(yaml).toContain("skills: [triage]");
  });

  it("approves a recruit only after the person says yes on the card", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    const status = async (slug: string) =>
      (await api("GET", `/api/crew/${slug}`)).json().crew.status as string;
    const approveTurn = async (slug: string, decision: "deny" | "always") => {
      events.length = 0;
      t.faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("recruit_crew_member", {
            slug,
            name: slug,
            role: "keeps the pantry stocked",
            persona: `# ${slug}\n\nYou keep the pantry stocked.`,
          }),
        ]),
        fauxAssistantMessage([fauxToolCall("approve_crew_member", { slug })]),
        fauxAssistantMessage("Done."),
      ]);
      ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "hire someone" }));
      await until(() => events.some((e) => e.type === "approval_request"));
      expect(await status(slug)).toBe("pending_review");
      const req = events.find((e) => e.type === "approval_request");
      if (req?.type !== "approval_request") throw new Error("no request");
      expect(req.approval.toolName).toBe("approve_crew_member");
      ws.send(JSON.stringify({ type: "approve", approvalId: req.approval.id, decision }));
      await until(() => events.some((e) => e.type === "status" && !e.busy));
    };

    await approveTurn("pantry", "deny");
    expect(await status("pantry")).toBe("pending_review");
    await approveTurn("larder", "always");
    expect(await status("larder")).toBe("active");
    // "Always allow" never lets the Captain approve crew on its own later.
    const yaml = (await api("GET", "/api/crew/captain")).json().crew.manifestYaml;
    expect(yaml).not.toContain("approve_crew_member");
    ws.terminate();
  });

  it("keeps members to their own settings", async () => {
    const results = await turn(
      [
        ["update_person", { person: "me", schedule: "nights" }],
        ["update_person", { person: "Addison", diet: "keto" }],
        ["update_person", { person: "me", monthlyCapUsd: 5 }],
        ["update_household", { location: "Bergen" }],
      ],
      memberCookie,
    );
    expect(results[0]).toContain("Updated Sam Rivera: schedule");
    expect(results[1]).toContain("can only change their own settings");
    expect(results[2]).toContain("only the owner can set spending caps");
    expect(results[3]).toContain("only an owner or admin");
    const me = (await api("GET", "/api/profile", undefined, memberCookie)).json();
    expect(me.profile.schedule).toBe("nights");
    expect(me.household.location).toBe("Oslo");
  });
});
