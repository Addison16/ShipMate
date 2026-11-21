import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based sign-in codes as authenticator apps make them (RFC 6238): HMAC-SHA1, six digits,
 * a new code every 30 seconds.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase().replace(/[\s=-]/g, "")) {
    const n = ALPHABET.indexOf(ch);
    if (n < 0) throw new Error("not base32");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes, as the base32 text authenticator apps take. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/** The six-digit code for one 30-second step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const at = (mac[mac.length - 1] ?? 0) & 15;
  const n = mac.readUInt32BE(at) & 0x7fffffff;
  return String(n % 1_000_000).padStart(6, "0");
}

/**
 * The step a code belongs to, or null when it is wrong. The step before and after now also
 * count, for a phone clock that is a little off. `after` refuses a code already used.
 */
export function matchTotp(
  secret: string,
  code: string,
  nowMs: number,
  after: number | null = null,
): number | null {
  const given = Buffer.from(code.replace(/\s/g, ""));
  if (given.length !== 6) return null;
  const now = totpStep(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (after !== null && step <= after) continue;
    if (timingSafeEqual(given, Buffer.from(totpCode(secret, step)))) return step;
  }
  return null;
}

/** The address a QR code carries, which authenticator apps also open when tapped. */
export function otpauthUri(secret: string, account: string, issuer = "Shipmate"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
