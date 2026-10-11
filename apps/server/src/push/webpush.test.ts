import { createECDH, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt } from "./fake.js";
import { encryptPayload, generateVapidKeys, sendPush, vapidAuthorization } from "./webpush.js";

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

/** RFC 8291 appendix A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  /** Section 5: the 86-byte header followed by the ciphertext. */
  result:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("web push encryption", () => {
  it("matches the RFC 8291 example byte for byte", () => {
    const out = encryptPayload(
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      Buffer.from(RFC.plaintext),
      {
        salt: b(RFC.salt),
        serverPrivateKey: b(RFC.asPrivate),
      },
    );
    expect(out.toString("base64url")).toBe(RFC.result);
    expect(decrypt(out, b(RFC.uaPrivate), b(RFC.auth))).toBe(RFC.plaintext);
  });

  it("round-trips with fresh keys and refuses malformed subscriptions", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const target = {
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    };
    const out = encryptPayload(target, Buffer.from('{"title":"Ahoy"}'));
    expect(decrypt(out, ua.getPrivateKey(), auth)).toBe('{"title":"Ahoy"}');
    expect(() => encryptPayload({ ...target, p256dh: "AAAA" }, Buffer.from("x"))).toThrow();
    expect(() => encryptPayload(target, Buffer.alloc(5000))).toThrow(/too large/);
  });
});

describe("VAPID", () => {
  it("signs a JWT for the push service's origin with the server key", () => {
    const keys = generateVapidKeys();
    expect(b(keys.publicKey)).toHaveLength(65);
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      keys,
      "https://ship.example",
      1_700_000_000_000,
    );
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m as unknown as string[];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b(c as string).toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_700_000_000 + 12 * 3600,
      sub: "https://ship.example",
    });
    const pub = b(keys.publicKey);
    const key = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: pub.subarray(1, 33).toString("base64url"),
        y: pub.subarray(33).toString("base64url"),
      },
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key, dsaEncoding: "ieee-p1363" },
      b(sig as string),
    );
    expect(ok).toBe(true);
  });

  it("reports expired subscriptions as gone", async () => {
    const keys = generateVapidKeys();
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const target = {
      endpoint: "https://push.example/x",
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 1).toString("base64url"),
    };
    const calls: Record<string, string>[] = [];
    const send = (status: number) =>
      sendPush(
        target,
        { title: "t" },
        {
          keys,
          subject: "mailto:a@b.c",
          topic: "approval:1234-5678",
          fetch: async (_url, init) => {
            calls.push(init.headers);
            return { status };
          },
        },
      );
    expect(await send(201)).toBe("sent");
    expect(await send(410)).toBe("gone");
    expect(await send(404)).toBe("gone");
    expect(await send(500)).toBe("failed");
    expect(calls[0]).toMatchObject({ "content-encoding": "aes128gcm", topic: "approval1234-5678" });
  });
});
