import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

const LOGO =
  '<svg viewBox="0 0 64 64" fill="currentColor"><circle cx="32" cy="32" r="20"/><path opacity=".5" d="M12 32h40"/></svg>';

const THEME = {
  name: "Head Office",
  description: "A company with a CEO",
  accent: "#2563eb",
  neutral: "gray",
  font: "system",
  corners: "sharp",
  logo: LOGO,
  words: { captain: "CEO", crew: "Team", crewMember: "team member", bridge: "Office" },
  voice: "Talk like a sharp, upbeat chief of staff. Say 'Let's ship it' when something is done.",
};

describe.skipIf(!db)("custom themes", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let member = "";
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    t = await testApp(db as string, { watches: false });
    const setup = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
    });
    owner = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    await api("POST", "/api/users", {
      email: "sam@example.com",
      displayName: "Sam",
      password: "correct horse",
      role: "member",
    });
    const login = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "sam@example.com", password: "correct horse" },
    });
    member = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  });
  afterAll(async () => {
    await t?.app.close();
  });

  async function turn(text: string) {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: owner } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    return { events, messages };
  }

  it("imports, lists, exports and protects themes", async () => {
    const bad = await api("POST", "/api/themes", { ...THEME, accent: "blue", logo: "<svg/>" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/accent must be a hex color/);

    const res = await api("POST", "/api/themes", { shipmate: "theme", version: 1, ...THEME });
    expect(res.statusCode).toBe(200);
    const theme = res.json().theme;
    expect(theme).toMatchObject({
      name: "Head Office",
      canEdit: true,
      createdBy: { name: "Addison" },
    });
    expect(theme.logo).toContain('xmlns="http://www.w3.org/2000/svg"');

    // Everyone sees it; only its maker or an admin changes it.
    const seen = (await api("GET", "/api/themes", undefined, member)).json().themes;
    expect(seen).toMatchObject([{ id: theme.id, canEdit: false }]);
    expect((await api("DELETE", `/api/themes/${theme.id}`, undefined, member)).statusCode).toBe(
      403,
    );

    const file = await api("GET", `/api/themes/${theme.id}/file`);
    expect(file.headers["content-disposition"]).toContain("head-office.shipmate-theme.json");
    expect(file.json()).toMatchObject({ shipmate: "theme", version: 1, name: "Head Office" });

    // Picking it is a preference; a deleted theme can't be picked and drops off whoever used it.
    const picked = await api("PATCH", "/api/auth/preferences", { customTheme: theme.id }, member);
    expect(picked.json().user.preferences.customTheme).toBe(theme.id);
    await api("DELETE", `/api/themes/${theme.id}`);
    const me = (await api("GET", "/api/auth/me", undefined, member)).json();
    expect(me.user.preferences.customTheme).toBeNull();
    expect(
      (await api("PATCH", "/api/auth/preferences", { customTheme: theme.id }, member)).statusCode,
    ).toBe(404);
  });

  it("lets the Captain follow the guide, fix problems, save, preview and switch", async () => {
    let afterGuide = "";
    let afterBadSave = "";
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("theme_build_guide", {})]),
      (context) => {
        afterGuide = JSON.stringify(context.messages);
        return fauxAssistantMessage([fauxToolCall("save_theme", { ...THEME, accent: "navy" })]);
      },
      (context) => {
        afterBadSave = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage([fauxToolCall("save_theme", THEME)]);
      },
      fauxAssistantMessage("Tap Try it to see it."),
    ]);
    const { events, messages } = await turn("Make me a custom theme: a company with a CEO");
    expect(afterGuide).toContain("Building a custom theme");
    expect(afterBadSave).toContain("accent must be a hex color");
    expect(events).toContainEqual({ type: "themes_changed" });

    const card = messages.find((m: { meta: unknown }) => m.meta && "theme" in (m.meta as object));
    expect(card.content).toBe('Captain made the theme "Head Office".');
    const id = card.meta.theme.id as string;
    expect((await api("GET", `/api/themes/${id}`)).json().theme.words.captain).toBe("CEO");
    // The card comes before the Captain's last words.
    expect(messages.at(-1).content).toBe("Tap Try it to see it.");

    // Switching in chat updates the open app, and the crew talks in the theme from then on.
    let prompt = "";
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("use_theme", { id })]),
      fauxAssistantMessage("Done."),
    ]);
    const switched = await turn("use it");
    expect(switched.events).toContainEqual(
      expect.objectContaining({
        type: "preferences_changed",
        preferences: expect.objectContaining({ customTheme: id }),
      }),
    );
    t.faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context);
        return fauxAssistantMessage("Hi.");
      },
    ]);
    await turn("hello");
    expect(prompt).toContain("Addison's theme: Head Office");
    expect(prompt).toContain('the coordinator is called \\"CEO\\"');
    expect(prompt).toContain("Let's ship it");

    // Back to the standard look.
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("use_theme", { id: "default" })]),
      fauxAssistantMessage("Back to normal."),
    ]);
    await turn("switch back");
    expect((await api("GET", "/api/auth/me")).json().user.preferences.customTheme).toBeNull();
  });
});
