import { createHash, randomBytes } from "node:crypto";
import type { TwoStepSetup } from "@shipmate/core";
import { type Db, users } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError, type UserRow, verifyPassword } from "../auth.js";
import { matchTotp, newTotpSecret, otpauthUri } from "../totp.js";

const BACKUP_CODES = 8;
const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");
/** Backup codes are typed by hand: case, spaces and the dash do not matter. */
const tidy = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

function newBackupCode(): string {
  // No 0/o/1/l, which are easy to misread on paper.
  const letters = "abcdefghijkmnpqrstuvwxyz23456789";
  const pick = Array.from(randomBytes(8), (b) => letters[b % letters.length]).join("");
  return `${pick.slice(0, 4)}-${pick.slice(4)}`;
}

/**
 * Sign-in codes: after the password, a six-digit code from an authenticator app. Backup codes
 * (each works once) cover a lost phone; the owner can also turn it off for someone.
 */
export class TwoStepService {
  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
    /** False while SHIPMATE_SIGN_IN_CODES=off: sign-in then asks nobody for a code. */
    private readonly asked = true,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether sign-in must ask this person for a code. */
  required(user: UserRow): boolean {
    return this.asked && user.totpEnabledAt !== null;
  }

  /** Start (or restart) setting up. Nothing changes at sign-in until `enable`. */
  async setup(user: UserRow): Promise<TwoStepSetup> {
    if (user.totpEnabledAt) throw new HttpError(409, "Sign-in codes are already on.");
    if (!user.passwordHash) {
      throw new HttpError(400, "You sign in without a password here, so codes do not apply.");
    }
    const secret = newTotpSecret();
    await this.db
      .update(users)
      .set({ totpSecret: this.vault.encrypt(secret), totpLastStep: null, totpBackupCodes: null })
      .where(eq(users.id, user.id));
    return { secret, uri: otpauthUri(secret, user.email) };
  }

  /** Turn codes on, once the app shows the right code. Returns the backup codes, shown once. */
  async enable(user: UserRow, code: string, password: string): Promise<string[]> {
    if (user.totpEnabledAt) throw new HttpError(409, "Sign-in codes are already on.");
    if (!user.totpSecret) throw new HttpError(400, "Start the setup first.");
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new HttpError(400, "That password is not right.");
    }
    const step = matchTotp(this.vault.decrypt(user.totpSecret), code, this.now());
    if (step === null) {
      throw new HttpError(400, "That code is not right. Check the app and try the newest code.");
    }
    const backup = Array.from({ length: BACKUP_CODES }, newBackupCode);
    await this.db
      .update(users)
      .set({
        totpEnabledAt: new Date(this.now()),
        totpLastStep: step,
        totpBackupCodes: backup.map((c) => hashOf(tidy(c))),
      })
      .where(eq(users.id, user.id));
    return backup;
  }

  /**
   * Whether a code is right for this person: the app's current code (never the same one twice)
   * or an unused backup code, which is then spent.
   */
  async check(user: UserRow, code: string): Promise<boolean> {
    if (!user.totpEnabledAt || !user.totpSecret) return false;
    const step = matchTotp(
      this.vault.decrypt(user.totpSecret),
      code,
      this.now(),
      user.totpLastStep,
    );
    if (step !== null) {
      await this.db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
      return true;
    }
    const left = user.totpBackupCodes ?? [];
    const hash = hashOf(tidy(code));
    if (!left.includes(hash)) return false;
    await this.db
      .update(users)
      .set({ totpBackupCodes: left.filter((h) => h !== hash) })
      .where(eq(users.id, user.id));
    return true;
  }

  /** Turn codes off without asking for one (after `check`, or by the owner for someone else). */
  async clear(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpBackupCodes: null })
      .where(eq(users.id, userId));
  }
}
