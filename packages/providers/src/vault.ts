import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * AES-256-GCM vault keyed from SHIPMATE_SECRET via HKDF. Ciphertext layout:
 * base64( iv(12) || tag(16) || data ).
 */
export class SecretVault {
  readonly #key: Buffer;
  constructor(masterSecret: string) {
    if (masterSecret.length < 16) throw new Error("SHIPMATE_SECRET must be at least 16 characters");
    this.#key = Buffer.from(hkdfSync("sha256", masterSecret, "shipmate-vault", "secrets-v1", 32));
  }
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}
