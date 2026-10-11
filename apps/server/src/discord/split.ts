import { splitMessage as split } from "../chat/split.js";

/** Discord's limit on one message's content. */
export const DISCORD_LIMIT = 2000;

/** See chat/split.ts; defaults to Discord's limit. */
export function splitMessage(text: string, limit = DISCORD_LIMIT): string[] {
  return split(text, limit);
}
