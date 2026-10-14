import { type Db, secrets } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError } from "../auth.js";

/** Where the key lives in the secrets table. */
const KEY_REF = "gemini-cli:api-key";

/**
 * The Gemini API key an owner gave on the Providers page for the Gemini CLI engine, kept
 * encrypted like other keys. It reaches the CLI only in its environment (GEMINI_API_KEY), and is
 * never sent back to the web app.
 */
export class GeminiKeyService {
  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
  ) {}

  async get(): Promise<string | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.ref, KEY_REF)).limit(1);
    if (!row) return null;
    try {
      return this.vault.decrypt(row.ciphertext);
    } catch {
      return null;
    }
  }

  async saved(): Promise<boolean> {
    const [row] = await this.db
      .select({ ref: secrets.ref })
      .from(secrets)
      .where(eq(secrets.ref, KEY_REF))
      .limit(1);
    return Boolean(row);
  }

  /** Save the key, or remove it with null or an empty string. */
  async set(key: string | null) {
    const value = key?.trim() ?? "";
    if (!value) {
      await this.db.delete(secrets).where(eq(secrets.ref, KEY_REF));
      return;
    }
    if (value.length > 500 || /\s/.test(value)) {
      throw new HttpError(400, "That doesn't look like a Gemini API key.");
    }
    const ciphertext = this.vault.encrypt(value);
    await this.db
      .insert(secrets)
      .values({ ref: KEY_REF, ciphertext })
      .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
  }
}
