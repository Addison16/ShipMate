import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import type { PushPayload } from "@shipmate/core";
import type { PushFetch } from "./webpush.js";

/**
 * A browser and its push service for tests: makes subscriptions with real keys, accepts
 * deliveries, and decrypts them the way a browser would.
 */
export class FakePushService {
  /** Status to answer per endpoint (default 201). */
  status = new Map<string, number>();
  received: { endpoint: string; headers: Record<string, string>; payload: PushPayload }[] = [];
  #devices = new Map<string, { privateKey: Buffer; auth: Buffer }>();
  #seq = 0;

  /** A new subscription, as PushManager.subscribe() would return it. */
  subscription(host = "fcm.googleapis.com") {
    this.#seq += 1;
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = Buffer.alloc(16, this.#seq);
    const endpoint = `https://${host}/fcm/send/device-${this.#seq}`;
    this.#devices.set(endpoint, { privateKey: ecdh.getPrivateKey(), auth });
    return {
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    };
  }

  readonly fetch: PushFetch = async (url, init) => {
    const device = this.#devices.get(url);
    if (device) {
      this.received.push({
        endpoint: url,
        headers: init.headers,
        payload: JSON.parse(decrypt(init.body, device.privateKey, device.auth)) as PushPayload,
      });
    }
    return { status: this.status.get(url) ?? (device ? 201 : 404) };
  };

  for(endpoint: string): PushPayload[] {
    return this.received.filter((r) => r.endpoint === endpoint).map((r) => r.payload);
  }
}

/** RFC 8291 decryption with the subscription's private key. */
export function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const h = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
  const expand = (s: Buffer, ikm: Buffer, info: string | Buffer, n: number) =>
    h(h(s, ikm), Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, n);
  const ikm = expand(
    auth,
    secret,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const cek = expand(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = expand(salt, ikm, "Content-Encoding: nonce\0", 12);
  const data = body.subarray(21 + idlen);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}
