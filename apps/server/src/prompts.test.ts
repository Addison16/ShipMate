import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Saved prompts", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let kid = "";
  let other = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
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
  const titles = async (cookie: string) =>
    (await api("GET", "/api/prompts", undefined, cookie))
      .json()
      .prompts.map((p: { title: string }) => p.title);

  beforeAll(async () => {
    t = await testApp(db as string);
    owner = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    for (const email of ["kid@example.com", "other@example.com"]) {
      await api("POST", "/api/users", {
        email,
        displayName: email,
        password: "password1",
        role: "member",
      });
    }
    const login = async (email: string) =>
      cookieOf(await api("POST", "/api/auth/login", { email, password: "password1" }, ""));
    kid = await login("kid@example.com");
    other = await login("other@example.com");
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("keeps private prompts private and shared ones for everyone, sorted by title", async () => {
    const mine = (
      await api("POST", "/api/prompts", { title: "weekly plan", body: "Plan my week." }, kid)
    ).json().prompt;
    expect(mine).toMatchObject({ title: "weekly plan", shared: false, mine: true });
    await api(
      "POST",
      "/api/prompts",
      { title: "Meal plan", body: "Plan dinners.", shared: true },
      kid,
    );
    await api("POST", "/api/prompts", { title: "Budget", body: "Check the budget." });
    expect(await titles(kid)).toEqual(["Meal plan", "weekly plan"]);
    expect(await titles(owner)).toEqual(["Budget", "Meal plan"]);
    expect(await titles(other)).toEqual(["Meal plan"]);
    expect((await api("PATCH", `/api/prompts/${mine.id}`, { body: "x" })).statusCode).toBe(404);
    expect((await api("POST", "/api/prompts", { title: " ", body: "x" })).statusCode).toBe(400);
    expect((await api("POST", "/api/prompts", { title: "x", body: "" })).statusCode).toBe(400);
  });

  it("lets the saver or an admin change a shared prompt, and nobody else", async () => {
    const { prompts } = (await api("GET", "/api/prompts", undefined, other)).json();
    const meal = prompts.find((p: { title: string }) => p.title === "Meal plan");
    expect(meal.mine).toBe(false);
    expect((await api("PATCH", `/api/prompts/${meal.id}`, { body: "x" }, other)).statusCode).toBe(
      403,
    );
    expect((await api("DELETE", `/api/prompts/${meal.id}`, undefined, other)).statusCode).toBe(403);
    const edited = await api("PATCH", `/api/prompts/${meal.id}`, { title: "Dinner plan" }, kid);
    expect(edited.json().prompt).toMatchObject({ title: "Dinner plan", body: "Plan dinners." });
    // An admin unshares it: it goes back to the person who saved it.
    await api("PATCH", `/api/prompts/${meal.id}`, { shared: false });
    expect(await titles(owner)).toEqual(["Budget"]);
    expect(await titles(kid)).toEqual(["Dinner plan", "weekly plan"]);
    expect((await api("DELETE", `/api/prompts/${meal.id}`, undefined, kid)).statusCode).toBe(200);
    expect(await titles(kid)).toEqual(["weekly plan"]);
    expect((await api("DELETE", "/api/prompts/nope", undefined, kid)).statusCode).toBe(404);
  });
});
