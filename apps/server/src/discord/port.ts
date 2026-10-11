/**
 * Everything Shipmate needs from Discord, behind one small interface. The discord.js adapter
 * (discordjs.ts) talks to the real gateway and REST API; tests use FakeDiscordPort (fake.ts).
 */

/** A problem with Discord, already phrased for the person reading the settings page. */
export class DiscordError extends Error {}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordIdentity {
  applicationId: string;
  /** Servers the bot has been added to. */
  guilds: DiscordGuild[];
}

export interface DiscordWebhook {
  id: string;
  token: string;
}

export interface WebhookMessage {
  content: string;
  username: string;
  avatarURL?: string;
  /** The only accounts that may be pinged; @everyone, @here and roles never are. */
  mentionUserIds: string[];
}

export interface BotButton {
  customId: string;
  label: string;
  style: "primary" | "secondary" | "success" | "danger";
}

export interface BotMessage {
  content: string;
  mentionUserIds: string[];
  /** Omit or empty to show (or leave) no buttons. */
  buttons?: BotButton[];
}

export interface ChannelSpec {
  name: string;
  topic: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  guildId: string;
  /** A text channel that can hold webhooks. */
  text: boolean;
}

export type DiscordEvent =
  | {
      type: "message";
      id: string;
      channelId: string;
      guildId: string | null;
      authorId: string;
      authorIsBot: boolean;
      /** Set when a webhook (including our own crew posts) sent it. */
      webhookId: string | null;
      content: string;
    }
  | {
      /** `/shipmate link code:<code>` */
      type: "link_command";
      userId: string;
      channelId: string | null;
      guildId: string | null;
      code: string;
      /** Ephemeral reply; must be called once, within Discord's three seconds. */
      reply: (content: string) => Promise<void>;
    }
  | {
      type: "button";
      userId: string;
      channelId: string | null;
      messageId: string;
      customId: string;
      /** Ephemeral reply to the clicker only. */
      reply: (content: string) => Promise<void>;
      /** Acknowledge without a reply (the message is edited separately). */
      acknowledge: () => Promise<void>;
    }
  | {
      /** The gateway dropped and will not come back by itself (bad token, missing intent). */
      type: "disconnected";
      error: string | null;
    };

export interface DiscordClientPort {
  /** Log in to the gateway. Throws DiscordError with a plain-words message. */
  connect(token: string): Promise<DiscordIdentity>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  /** Called for every incoming message and interaction. Replaces any earlier listener. */
  listen(handler: (event: DiscordEvent) => void): void;

  /** Register the guild's `/shipmate link` slash command. */
  registerCommands(guildId: string): Promise<void>;
  /**
   * Make sure a "Shipmate" category exists in the guild with one text channel per spec (found
   * by name inside the category, else created). Returns the channel id per spec name.
   */
  ensureCategoryAndChannels(guildId: string, specs: ChannelSpec[]): Promise<Map<string, string>>;
  channelInfo(channelId: string): Promise<ChannelInfo | null>;
  /** Cached channel name, for status pages; null when unknown. */
  channelName(channelId: string): string | null;
  createWebhook(channelId: string, name: string): Promise<DiscordWebhook>;

  sendWebhook(webhook: DiscordWebhook, message: WebhookMessage): Promise<void>;
  /** Returns the new message's id. */
  sendBotMessage(channelId: string, message: BotMessage): Promise<string>;
  editBotMessage(channelId: string, messageId: string, message: BotMessage): Promise<void>;
  reply(channelId: string, messageId: string, content: string): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  typing(channelId: string): Promise<void>;
}
