import type {
  BotMessage,
  ChannelInfo,
  ChannelSpec,
  DiscordClientPort,
  DiscordEvent,
  DiscordIdentity,
  DiscordWebhook,
  WebhookMessage,
} from "./port.js";
import { DiscordError } from "./port.js";

/**
 * An in-memory Discord for tests: one server, channels and webhooks it hands out, and a record
 * of everything posted. Helpers simulate people typing messages, slash commands and clicks.
 */
export class FakeDiscordPort implements DiscordClientPort {
  static readonly TOKEN = "fake-bot-token";
  readonly guild = { id: "900000000000000001", name: "Test Harbor" };
  readonly applicationId = "800000000000000001";
  connected = false;
  commandsRegistered: string[] = [];
  channels = new Map<string, ChannelInfo & { topic: string; parentId: string | null }>();
  webhooks = new Map<string, DiscordWebhook & { channelId: string }>();
  webhookPosts: (WebhookMessage & { webhookId: string; channelId: string })[] = [];
  botMessages: (BotMessage & { id: string; channelId: string })[] = [];
  edits: (BotMessage & { messageId: string; channelId: string })[] = [];
  replies: { channelId: string; messageId: string; content: string }[] = [];
  reactions: { channelId: string; messageId: string; emoji: string }[] = [];
  deleted: { channelId: string; messageId: string }[] = [];
  typingCalls: string[] = [];
  #handler: (event: DiscordEvent) => void = () => {};
  #seq = 1000;

  #id() {
    this.#seq += 1;
    return `7000000000000${this.#seq}`;
  }

  async connect(token: string): Promise<DiscordIdentity> {
    if (token !== FakeDiscordPort.TOKEN) throw new DiscordError("Discord rejected the bot token.");
    this.connected = true;
    return { applicationId: this.applicationId, guilds: [this.guild] };
  }
  async disconnect() {
    this.connected = false;
  }
  listen(handler: (event: DiscordEvent) => void) {
    this.#handler = handler;
  }
  async registerCommands(guildId: string) {
    this.commandsRegistered.push(guildId);
  }
  async ensureCategoryAndChannels(guildId: string, specs: ChannelSpec[]) {
    let category = [...this.channels.values()].find((c) => c.name === "Shipmate" && !c.text);
    if (!category) {
      category = {
        id: this.#id(),
        name: "Shipmate",
        guildId,
        text: false,
        topic: "",
        parentId: null,
      };
      this.channels.set(category.id, category);
    }
    const out = new Map<string, string>();
    for (const spec of specs) {
      const found = [...this.channels.values()].find(
        (c) => c.text && c.parentId === category.id && c.name === spec.name,
      );
      const channel = found ?? {
        id: this.#id(),
        name: spec.name,
        guildId,
        text: true,
        topic: spec.topic,
        parentId: category.id,
      };
      this.channels.set(channel.id, channel);
      out.set(spec.name, channel.id);
    }
    return out;
  }
  /** A channel someone made by hand, to bind to. */
  addChannel(name: string): string {
    const id = this.#id();
    this.channels.set(id, {
      id,
      name,
      guildId: this.guild.id,
      text: true,
      topic: "",
      parentId: null,
    });
    return id;
  }
  async channelInfo(channelId: string): Promise<ChannelInfo | null> {
    const c = this.channels.get(channelId);
    return c ? { id: c.id, name: c.name, guildId: c.guildId, text: c.text } : null;
  }
  channelName(channelId: string) {
    return this.channels.get(channelId)?.name ?? null;
  }
  async createWebhook(channelId: string) {
    const webhook = { id: this.#id(), token: `webhook-token-${channelId}`, channelId };
    this.webhooks.set(webhook.id, webhook);
    return { id: webhook.id, token: webhook.token };
  }
  async sendWebhook(webhook: DiscordWebhook, message: WebhookMessage) {
    const known = this.webhooks.get(webhook.id);
    if (!known || known.token !== webhook.token) throw new DiscordError("Unknown webhook.");
    this.webhookPosts.push({ ...message, webhookId: webhook.id, channelId: known.channelId });
  }
  async sendBotMessage(channelId: string, message: BotMessage) {
    const id = this.#id();
    this.botMessages.push({ ...message, id, channelId });
    return id;
  }
  async editBotMessage(channelId: string, messageId: string, message: BotMessage) {
    this.edits.push({ ...message, channelId, messageId });
  }
  async reply(channelId: string, messageId: string, content: string) {
    this.replies.push({ channelId, messageId, content });
  }
  async react(channelId: string, messageId: string, emoji: string) {
    this.reactions.push({ channelId, messageId, emoji });
  }
  async deleteMessage(channelId: string, messageId: string) {
    this.deleted.push({ channelId, messageId });
  }
  async typing(channelId: string) {
    this.typingCalls.push(channelId);
  }

  // ---------- simulating people ----------

  /** Someone posts in a channel. Returns the message id. */
  message(
    channelId: string,
    authorId: string,
    content: string,
    options: { bot?: boolean; webhookId?: string } = {},
  ): string {
    const id = this.#id();
    this.#handler({
      type: "message",
      id,
      channelId,
      guildId: this.guild.id,
      authorId,
      authorIsBot: options.bot ?? false,
      webhookId: options.webhookId ?? null,
      content,
    });
    return id;
  }

  /** `/shipmate link code:<code>`; resolves with the ephemeral reply. */
  slashLink(userId: string, code: string, channelId: string | null = null): Promise<string> {
    return new Promise((resolve) => {
      this.#handler({
        type: "link_command",
        userId,
        channelId,
        guildId: this.guild.id,
        code,
        reply: async (content) => resolve(content),
      });
    });
  }

  /** A button click; resolves with the ephemeral reply, or "acknowledged". */
  click(userId: string, messageId: string, customId: string): Promise<string> {
    return new Promise((resolve) => {
      this.#handler({
        type: "button",
        userId,
        channelId: null,
        messageId,
        customId,
        reply: async (content) => resolve(content),
        acknowledge: async () => resolve("acknowledged"),
      });
    });
  }
}
