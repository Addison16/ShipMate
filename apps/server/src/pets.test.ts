import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ApprovalDto, ServerEvent } from "@shipmate/core";
import { EXAMPLE_PET_SVG, petGuide } from "@shipmate/crew";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearBackground,
  decodePng,
  encodePng,
  type Rgba,
  shrink,
  tidyPetPicture,
} from "./pets/png.js";
import { imageFromResponsesStream, picturePrompt } from "./pets/service.js";
import { checkPetSvg } from "./pets/svg.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

/** A white square with a red disc in the middle. */
function disc(size: number): Rgba {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = Math.hypot(x - size / 2, y - size / 2) < size / 4;
      data.set(inside ? [220, 30, 30, 255] : [255, 255, 255, 255], i);
    }
  }
  return { width: size, height: size, data };
}

describe("pet pictures", () => {
  it("round-trips a PNG and clears a plain background", () => {
    const png = encodePng(disc(64));
    const back = decodePng(png);
    expect(back?.width).toBe(64);
    expect(back?.data.slice(0, 4)).toEqual(new Uint8Array([255, 255, 255, 255]));
    const cleared = clearBackground(back as Rgba);
    // Corner gone, middle kept.
    expect(cleared.data[3]).toBe(0);
    expect(cleared.data[(32 * 64 + 32) * 4 + 3]).toBe(255);
  });

  it("leaves busy or already transparent backgrounds alone, and shrinks big pictures", () => {
    const busy = disc(16);
    busy.data.set([0, 0, 0, 255], 0);
    expect(clearBackground(busy)).toBe(busy);
    const small = shrink(disc(800), 384);
    expect([small.width, small.height]).toEqual([384, 384]);
    const tidy = decodePng(tidyPetPicture(encodePng(disc(800))));
    expect(tidy?.width).toBe(384);
    expect(tidy?.data[3]).toBe(0);
    // Not a PNG: kept as it is.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(tidyPetPicture(jpeg)).toBe(jpeg);
  });

  it("accepts plain shapes and refuses anything active in a drawn pet", () => {
    expect(checkPetSvg(EXAMPLE_PET_SVG)).toHaveProperty("svg");
    expect(checkPetSvg(`\`\`\`svg\n${EXAMPLE_PET_SVG}\n\`\`\``)).toHaveProperty("svg");
    const bad = [
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1"><circle onload="x()" r="1"/></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://x.test/a.png"/></svg>',
      '<svg viewBox="0 0 1 1"><use href="https://x.test/a.svg#x"/></svg>',
      '<svg viewBox="0 0 1 1"><circle fill="url(https://x.test/)" r="1"/></svg>',
      '<svg viewBox="0 0 1 1"><circle style="fill:red" r="1"/></svg>',
      '<svg viewBox="0 0 1 1"><foreignObject/></svg>',
      '<svg viewBox="0 0 1 1"><text>Hi</text></svg>',
      '<svg viewBox="0 0 1 1">hello</svg>',
      '<svg viewBox="0 0 1 1"><!-- x --></svg>',
      "<div></div>",
    ];
    for (const svg of bad) expect(checkPetSvg(svg), svg).toHaveProperty("error");
    const ok = checkPetSvg('<svg viewBox="0 0 1 1"><circle fill="url(#g)" r="1"/></svg>');
    expect(ok).toEqual({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><circle fill="url(#g)" r="1"/></svg>',
    });
  });

  it("reads the picture out of a streamed Responses answer, or says why there is none", () => {
    const b64 = Buffer.from("png bytes").toString("base64");
    const stream = [
      'data: {"type":"response.created"}',
      `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${b64}"}}`,
      "data: [DONE]",
    ].join("\n\n");
    expect(Buffer.from(imageFromResponsesStream(stream)).toString()).toBe("png bytes");
    expect(() =>
      imageFromResponsesStream(
        'data: {"type":"error","error":{"message":"Tool not supported"}}\n\n',
      ),
    ).toThrow(/Tool not supported/);
    expect(() => imageFromResponsesStream('data: {"type":"response.completed"}')).toThrow(
      /without a picture/,
    );
  });

  it("asks image models for an original sticker-style creature", () => {
    const p = picturePrompt("a round otter with a chef's hat.");
    expect(p).toContain("a round otter with a chef's hat.");
    expect(p).toMatch(/No text/);
    expect(p).toMatch(/not based on any existing character/);
  });

  it("guides the build step by step, and teaches SVG only when the Captain draws", () => {
    const draws = petGuide({ roster: "- galley: Galley; no pet", paints: false, painter: "none" });
    expect(draws).toMatch(/Step 1\./);
    expect(draws).toMatch(/Step 7\./);
    expect(draws).toContain("<svg");
    const paints = petGuide({ roster: "-", paints: true, painter: "made by OpenAI." });
    expect(paints).not.toContain("<svg");
    expect(paints).toContain("A picture is made for you");
  });
});

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("building a pet with the Captain", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  let painted = 0;
  const api = (method: "GET" | "POST" | "PUT", url: string, body?: unknown) =>
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
    t = await testApp(db as string, {
      watches: false,
      petFetch: (async (url: string | URL | Request, init?: RequestInit) => {
        painted++;
        expect(String(url)).toBe("http://images.local/v1/images/generations");
        expect(JSON.parse(String(init?.body))).toMatchObject({ response_format: "b64_json" });
        const b64 = Buffer.from(encodePng(disc(64))).toString("base64");
        return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
      }) as typeof fetch,
    });
    const setup = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
    });
    cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  async function turn(text: string, answer: (a: ApprovalDto) => Promise<void>) {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => {
      const e = JSON.parse(raw.toString()) as ServerEvent;
      events.push(e);
      if (e.type === "approval_request") void answer(e.approval);
    });
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    return { events, messages };
  }

  it("has no pet until one is made, and the Captain draws one when no image model is set up", async () => {
    const before = (await api("GET", "/api/crew/shipwright")).json().crew;
    expect(before.pet).toBeNull();
    expect((await api("PUT", "/api/crew/shipwright/pet", { enabled: true })).statusCode).toBe(409);

    let toolResult = "";
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("pet_guide", {})]),
      fauxAssistantMessage([
        fauxToolCall("make_pet", { crew: "shipwright", name: "Bolt", look: "a small robot crab" }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("make_pet", {
          crew: "shipwright",
          name: "Bolt",
          look: "a small robot crab",
          svg: EXAMPLE_PET_SVG,
        }),
      ]),
      (context) => {
        toolResult = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage("Bolt is aboard.");
      },
    ]);
    const cards: ApprovalDto[] = [];
    const { messages } = await turn("give the shipwright a pet", async (a) => {
      cards.push(a);
      await api("POST", `/api/approvals/${a.id}`, { decision: "allow", answer: "Keep it" });
    });
    expect(cards).toMatchObject([
      { toolName: "ask_person", question: { text: "Keep Bolt as Shipwright's pet?" } },
    ]);
    const preview = messages.find(
      (m: { meta: unknown }) => m.meta && "petPreview" in (m.meta as object),
    );
    expect(preview.meta.petPreview).toMatchObject({ crew: { slug: "shipwright" }, name: "Bolt" });
    const draft = await api("GET", preview.meta.petPreview.url);
    expect(draft.headers["content-type"]).toContain("image/svg+xml");
    expect(draft.headers["content-security-policy"]).toContain("sandbox");
    expect(toolResult).toContain("Saved. Bolt is now Shipwright's pet");

    const crew = (await api("GET", "/api/crew/shipwright")).json().crew;
    expect(crew.pet).toMatchObject({
      name: "Bolt",
      shown: true,
      url: expect.stringMatching(/^\/api\/crew\/shipwright\/pet\?v=/),
    });
    const yaml = readFileSync(join(t.config.dirs.crew, "shipwright", "crew.yaml"), "utf8");
    expect(yaml).toMatch(/pet:\n\s+enabled: true\n\s+name: Bolt/);
    expect((await api("GET", crew.pet.url)).body).toContain("<svg");

    // Hidden and shown again from the crew page.
    const hidden = (await api("PUT", "/api/crew/shipwright/pet", { enabled: false })).json().crew;
    expect(hidden.pet).toMatchObject({ name: "Bolt", shown: false });
    const shown = (await api("PUT", "/api/crew/shipwright/pet", { enabled: true })).json().crew;
    expect(shown.pet).toMatchObject({ name: "Bolt", shown: true });
  });

  it("makes the picture with an image server when one is set up, and asks again on Try again", async () => {
    const saved = await api("PUT", "/api/pets/settings", {
      source: "custom",
      baseUrl: "http://images.local/v1/",
    });
    expect(saved.json()).toMatchObject({ source: "custom", baseUrl: "http://images.local/v1" });

    const results: string[] = [];
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("make_pet", { crew: "captain", name: "Pip", look: "a tidy owl" }),
      ]),
      (context) => {
        results.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage([
          fauxToolCall("make_pet", { crew: "captain", name: "Pip", look: "a tidy owl, blue" }),
        ]);
      },
      (context) => {
        results.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage("Pip is aboard.");
      },
    ]);
    const answers = ["Try again", "Keep it"];
    await turn("make the captain a pet", async (a) => {
      await api("POST", `/api/approvals/${a.id}`, { decision: "allow", answer: answers.shift() });
    });
    expect(painted).toBe(2);
    expect(results[0]).toContain("wants another try");
    expect(results[1]).toContain("Saved. Pip");
    const crew = (await api("GET", "/api/crew/captain")).json().crew;
    const picture = await api("GET", crew.pet.url);
    expect(picture.headers["content-type"]).toBe("image/png");
    // The white background was cleared.
    expect(decodePng(picture.rawPayload)?.data[3]).toBe(0);
  });
});
