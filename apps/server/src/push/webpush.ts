import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/**
 * Web Push with the standard library only: message encryption (RFC 8291, the aes128gcm content
 * coding of RFC 8188) and VAPID application server identification (RFC 8292).
 */

/** The server's VAPID key pair: P-256, base64url, as browsers and push services expect it. */
export interface VapidKeys {
  /** Uncompressed point (65 bytes), the `applicationServerKey` a browser subscribes with. */
  publicKey: string;
  /** The private scalar `d` (32 bytes). */
  privateKey: string;
}

/** What a browser hands out from PushManager.subscribe(). */
export interface PushTarget {
  endpoint: string;
  /** The subscription's P-256 public key, base64url. */
  p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  auth: string;
}

const b64u = (buf: Buffer) => buf.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  if (!pub.x || !pub.y || !priv.d) throw new Error("could not export the VAPID key");
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])),
    privateKey: priv.d,
  };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF in the single-block form RFC 8291 uses (output ≤ 32 bytes). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/**
 * Encrypt `payload` for one subscription. Returns the request body (header and one record).
 * `salt` and `serverKey` are only passed by tests checking the RFC's example values.
 */
export function encryptPayload(
  target: Pick<PushTarget, "p256dh" | "auth">,
  payload: Buffer,
  fixed: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = unb64u(target.p256dh);
  const authSecret = unb64u(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("invalid p256dh key");
  if (authSecret.length < 16) throw new Error("invalid auth secret");

  const ecdh = createECDH("prime256v1");
  if (fixed.serverPrivateKey) ecdh.setPrivateKey(fixed.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = fixed.salt ?? randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // A single record: the payload and the last-record delimiter, no padding.
  const recordSize = 4096;
  if (payload.length + 1 + 16 > recordSize) throw new Error("push payload is too large");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** The `Authorization: vapid t=…, k=…` header for a push service (RFC 8292). */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = Date.now(),
): string {
  const audience = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }),
    ),
  );
  const pub = unb64u(keys.publicKey);
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

export type PushFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: Buffer },
) => Promise<{ status: number }>;

export type SendResult = "sent" | "gone" | "failed";

/** Deliver one encrypted message. "gone" means the subscription expired (404/410): delete it. */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  options: {
    keys: VapidKeys;
    subject: string;
    /** Seconds the push service keeps the message for an offline device. */
    ttl?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    /** Replaces an undelivered message with the same topic (e.g. one per approval). */
    topic?: string;
    fetch?: PushFetch;
  },
): Promise<SendResult> {
  const body = encryptPayload(target, Buffer.from(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    ttl: String(options.ttl ?? 86_400),
    urgency: options.urgency ?? "normal",
    authorization: vapidAuthorization(target.endpoint, options.keys, options.subject),
  };
  if (options.topic) headers.topic = options.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const doFetch: PushFetch =
    options.fetch ??
    (async (url, init) => {
      const res = await fetch(url, { ...init, body: new Uint8Array(init.body) });
      await res.arrayBuffer().catch(() => undefined);
      return { status: res.status };
    });
  try {
    const res = await doFetch(target.endpoint, { method: "POST", headers, body });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.status >= 200 && res.status < 300 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
