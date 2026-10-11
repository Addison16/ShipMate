import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WeatherService } from "./services/weather.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Everyday life", () => {
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

  const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  /** Run one Bridge turn as the owner and wait for it to finish. */
  const turn = async (conversationId: string, message: string, cookie = ownerCookie) => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId, text: message }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    return events;
  };

  beforeAll(async () => {
    // Open-Meteo stand-in: every place is sunny Austin.
    const weather = new WeatherService(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("geocoding")
          ? {
              results: [
                {
                  name: "Austin",
                  admin1: "Texas",
                  country: "United States",
                  country_code: "US",
                  latitude: 30.27,
                  longitude: -97.74,
                  timezone: "America/Chicago",
                },
              ],
            }
          : {
              daily: {
                time: ["2026-10-11"],
                weather_code: [0],
                temperature_2m_max: [84],
                temperature_2m_min: [62],
                precipitation_probability_max: [0],
              },
            },
    }));
    t = await testApp(db as string, { weather });
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

  it("keeps shared and private lists with checkboxes", async () => {
    const shared = (await api("POST", "/api/lists", { name: "Groceries", kind: "grocery" })).json()
      .list;
    expect(shared).toMatchObject({ shared: true, owner: null, itemCount: 0 });
    const mine = (
      await api("POST", "/api/lists", { name: "Gifts", kind: "todo", shared: false })
    ).json().list;
    expect(mine.owner.name).toBe("Addison");

    // The member sees the shared list, not the owner's private one (not even its id).
    const theirs = (await api("GET", "/api/lists", undefined, memberCookie)).json().lists;
    expect(theirs.map((l: { name: string }) => l.name)).toEqual(["Groceries"]);
    expect((await api("GET", `/api/lists/${mine.id}`, undefined, memberCookie)).statusCode).toBe(
      404,
    );

    // Anyone can add to and check off a shared list.
    let list = (
      await api("POST", `/api/lists/${shared.id}/items`, { text: "Milk" }, memberCookie)
    ).json().list;
    list = (await api("POST", `/api/lists/${shared.id}/items`, { text: "milk " })).json().list;
    expect(list.items).toHaveLength(1);
    expect(list.items[0].addedBy).toBe("Kid");
    list = (await api("POST", `/api/lists/${shared.id}/items`, { text: "Eggs" })).json().list;
    const milk = list.items.find((i: { text: string }) => i.text === "Milk");
    list = (
      await api("PATCH", `/api/lists/${shared.id}/items/${milk.id}`, { checked: true })
    ).json().list;
    expect(list.items.map((i: { text: string; checked: boolean }) => [i.text, i.checked])).toEqual([
      ["Eggs", false],
      ["Milk", true],
    ]);
    expect(list.openCount).toBe(1);
    expect(
      (await api("POST", `/api/lists/${shared.id}/items`, { text: "Bill", dueOn: "2026-02-30" }))
        .statusCode,
    ).toBe(400);
    list = (await api("POST", `/api/lists/${shared.id}/clear`)).json().list;
    expect(list.items.map((i: { text: string }) => i.text)).toEqual(["Eggs"]);

    // Only its creator or an admin deletes a shared list.
    const kids = (
      await api("POST", "/api/lists", { name: "Chores", kind: "todo" }, memberCookie)
    ).json().list;
    expect(
      (await api("DELETE", `/api/lists/${shared.id}`, undefined, memberCookie)).statusCode,
    ).toBe(403);
    expect((await api("DELETE", `/api/lists/${kids.id}`)).statusCode).toBe(200);
  });

  it("lets crew read and write lists through tools, live to the web app", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("add_to_list", {
          list: "groceries",
          items: [{ text: "2 onions" }, { text: "Eggs" }, { text: "Rice", note: "basmati" }],
        }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("check_list_items", { list: "Groceries", items: ["onion"] }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("read_list", { list: "Groceries", includeChecked: true }),
      ]),
      fauxAssistantMessage("Added and checked."),
    ]);
    const events = await turn(conv.id, "add onions, eggs and rice, then check off the onions");
    expect(events.some((e) => e.type === "list_changed")).toBe(true);
    const tools = events.filter((e) => e.type === "tool" && e.phase === "end");
    expect(tools.map((e) => (e.type === "tool" ? e.summary : ""))).toEqual([
      expect.stringContaining("Already on the list: Eggs"),
      expect.stringContaining("checked off 2 onions"),
      expect.stringContaining("[x] 2 onions"),
    ]);
    const lists = (await api("GET", "/api/lists")).json().lists;
    const groceries = (
      await api(
        "GET",
        `/api/lists/${lists.find((l: { name: string }) => l.name === "Groceries").id}`,
      )
    ).json().list;
    expect(groceries.items.find((i: { text: string }) => i.text === "Rice")).toMatchObject({
      note: "basmati",
      addedBy: "Captain for Addison",
    });
  });

  it("shares household profiles with the crew", async () => {
    expect((await api("PUT", "/api/profile", { timezone: "Not/AZone" })).statusCode).toBe(400);
    expect((await api("PUT", "/api/profile", { secret: "x" })).statusCode).toBe(400);
    const mine = (
      await api("PUT", "/api/profile", {
        diet: "vegetarian, no peanuts",
        timezone: "America/Chicago",
        schedule: "Works 9-5; kids have soccer Tuesdays at 17:00",
      })
    ).json().profile;
    expect(mine).toMatchObject({ diet: "vegetarian, no peanuts", shared: false });
    await api("PUT", "/api/profile", { diet: "loves pasta", shared: true }, memberCookie);
    await api("PUT", "/api/profile", { budget: "secret budget" }, memberCookie);
    // Household facts: admins write, everyone reads.
    expect(
      (await api("PUT", "/api/household", { location: "Nowhere" }, memberCookie)).statusCode,
    ).toBe(403);
    await api("PUT", "/api/household", { location: "Austin, TX", notes: "Two kids, Sam (8)" });
    const kid = (await api("GET", "/api/profile", undefined, memberCookie)).json();
    expect(kid.household.location).toBe("Austin, TX");
    expect(kid.profile.diet).toBe("loves pasta");

    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    let system = "";
    let toolResult = "";
    t.faux.setResponses([
      (context) => {
        system = JSON.stringify(context.messages);
        return fauxAssistantMessage([fauxToolCall("read_profiles", {})]);
      },
      (context) => {
        toolResult = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage("Noted.");
      },
    ]);
    await turn(conv.id, "what's for dinner?");
    expect(system).toContain("Home: Austin, TX");
    expect(system).toContain("Diet: vegetarian, no peanuts");
    expect(system).toMatch(/Local time for Addison: .*\(America\/Chicago\)/);
    expect(system).toContain("Shared profiles of Kid");
    expect(toolResult).toContain("# Kid (shared)");
    expect(toolResult).toContain("loves pasta");

    // A profile that is not shared stays with its owner's crew.
    await api("PUT", "/api/profile", { shared: false }, memberCookie);
    t.faux.setResponses([
      (context) => {
        system = JSON.stringify(context.messages);
        return fauxAssistantMessage("Ok.");
      },
    ]);
    const conv2 = (await api("POST", "/api/conversations", {})).json().conversation;
    await turn(conv2.id, "hi");
    expect(system).not.toContain("Kid");
  });

  it("offers a daily briefing watch that reads weather, due items and activity", async () => {
    const bills = (await api("POST", "/api/lists", { name: "Bills", kind: "bills" })).json().list;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await api("POST", `/api/lists/${bills.id}/items`, {
      text: "Electricity",
      dueOn: tomorrow,
      note: "$84, autopay",
    });
    await api("POST", `/api/lists/${bills.id}/items`, { text: "Water", dueOn: "2099-01-01" });

    const { templates } = (await api("GET", "/api/watches/templates")).json();
    const briefing = templates.find((x: { id: string }) => x.id === "daily-briefing");
    // The Navigator (added from the starter pack) has the calendar, so it runs the briefing.
    expect(briefing).toMatchObject({ crewSlug: "navigator", cron: "0 7 * * *" });
    const watch = (
      await api("POST", "/api/watches", {
        name: briefing.name,
        crewSlug: briefing.crewSlug,
        trigger: { kind: "cron", expression: briefing.cron, timezone: "America/Chicago" },
        prompt: briefing.prompt,
      })
    ).json().watch;

    const seen: string[] = [];
    const capture = (context: { messages: unknown[] }) => {
      seen.push(JSON.stringify(context.messages.at(-1)));
    };
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_weather", {})]),
      (context) => {
        capture(context);
        return fauxAssistantMessage([fauxToolCall("due_soon", { days: 3 })]);
      },
      (context) => {
        capture(context);
        return fauxAssistantMessage([fauxToolCall("recent_activity", { hours: 12 })]);
      },
      (context) => {
        capture(context);
        return fauxAssistantMessage("Good morning! Sunny, 84°F. Electricity is due tomorrow.");
      },
    ]);
    const run = (await api("POST", `/api/watches/${watch.id}/run`)).json().run;
    let done: { status: string; output: string | null } | undefined;
    await until(async () => {
      const runs = (await api("GET", `/api/watches/${watch.id}/runs`)).json().runs;
      done = runs.find(
        (r: { id: string; status: string }) => r.id === run.id && r.status !== "running",
      );
      return !!done;
    });
    expect(done).toMatchObject({ status: "succeeded" });
    expect(done?.output).toContain("Electricity is due tomorrow");
    expect(seen[0]).toContain("Weather for Austin, Texas");
    expect(seen[1]).toContain("Electricity (Bills, due");
    expect(seen[1]).toContain("$84, autopay");
    expect(seen[1]).not.toContain("Water");
    // The list tools the crew used earlier show up as overnight activity.
    expect(seen[2]).toContain("List items the crew added");
    expect(seen[2]).toMatch(/on \\"Groceries\\" by Captain/);
  });

  it("searches and pins the person's own conversations", async () => {
    const a = (await api("POST", "/api/conversations", {})).json().conversation;
    const b = (await api("POST", "/api/conversations", {})).json().conversation;
    t.faux.setResponses([fauxAssistantMessage("The lasagna recipe needs ricotta and basil.")]);
    await turn(a.id, "Find me a vegetarian lasagna");
    t.faux.setResponses([fauxAssistantMessage("Your flight to Lisbon leaves at 9.")]);
    await turn(b.id, "When does my flight leave?");
    await api("PATCH", `/api/conversations/${b.id}`, { title: "Trip planning" });
    // Someone else's conversation never shows up.
    const theirs = (await api("POST", "/api/conversations", {}, memberCookie)).json().conversation;
    t.faux.setResponses([fauxAssistantMessage("Lasagna for the kid too.")]);
    await turn(theirs.id, "lasagna please", memberCookie);

    const search = async (q: string) =>
      (await api("GET", `/api/conversations/search?q=${encodeURIComponent(q)}`)).json().results;
    const lasagna = await search("lasagnas");
    expect(lasagna.map((r: { conversation: { id: string } }) => r.conversation.id)).toEqual([a.id]);
    expect(lasagna[0].matches[0].snippet).toContain("\uE000lasagna\uE001");
    expect(lasagna[0].matches.map((m: { author: string }) => m.author)).toContain("Captain");
    expect((await search("ricotta -basil")).length).toBe(0);
    const trip = await search("trip");
    expect(trip[0]).toMatchObject({ conversation: { id: b.id }, titleMatch: true });
    expect(await search("100%_")).toEqual([]);
    expect(await search("   ")).toEqual([]);

    // Pinned first, newest first after that.
    expect((await api("PATCH", `/api/conversations/${a.id}`, {})).statusCode).toBe(400);
    const pinned = (await api("PATCH", `/api/conversations/${a.id}`, { pinned: true })).json();
    expect(pinned.conversation.pinned).toBe(true);
    const order = (await api("GET", "/api/conversations")).json().conversations;
    expect(order[0].id).toBe(a.id);
    expect(order[1].id).toBe(b.id);
    expect(
      (await api("PATCH", `/api/conversations/${a.id}`, { pinned: true }, memberCookie)).statusCode,
    ).toBe(404);
    await api("PATCH", `/api/conversations/${a.id}`, { pinned: false });
    expect((await api("GET", "/api/conversations")).json().conversations[0].id).not.toBe(a.id);
  });
});
