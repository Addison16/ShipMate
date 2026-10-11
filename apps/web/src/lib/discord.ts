import type { DiscordStatusDto } from "@shipmate/core";

/** Whole seconds left until `expiresAt` (never negative; 0 when unparseable). */
export function secondsLeft(expiresAt: string, now: number = Date.now()): number {
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

/** "4:05", "0:09", "1:02:03", or "expired". */
export function formatCountdown(expiresAt: string, now: number = Date.now()): string {
  const s = secondsLeft(expiresAt, now);
  if (s <= 0) return "expired";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The bridge state in plain words, with a tone for the badge. */
export function discordState(d: DiscordStatusDto): {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
  detail: string;
} {
  if (!d.configured) {
    return {
      tone: "neutral",
      label: "not set up",
      detail: "No bot token is stored yet, so Shipmate is not on Discord.",
    };
  }
  if (d.connected) {
    return {
      tone: "ok",
      label: "connected",
      detail: d.guildName
        ? `Connected to the "${d.guildName}" server.`
        : d.guildId
          ? "Connected to Discord. The bot has not joined the chosen server yet; use the invite button."
          : "Connected to Discord. Paste a server (guild) id to choose where the crew lives.",
    };
  }
  return {
    tone: d.error ? "danger" : "warn",
    label: "not connected",
    detail: d.error ?? "A bot token is stored, but the bot is not connected right now.",
  };
}

/** Discord ids are snowflakes: 17 to 20 digits. */
export function isSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value.trim());
}
