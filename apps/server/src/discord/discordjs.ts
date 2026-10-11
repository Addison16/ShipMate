import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  WebhookClient,
} from "discord.js";
import {
  type BotButton,
  type BotMessage,
  type ChannelInfo,
  type ChannelSpec,
  type DiscordClientPort,
  DiscordError,
  type DiscordEvent,
  type DiscordIdentity,
  type DiscordWebhook,
  type WebhookMessage,
} from "./port.js";

const READY_TIMEOUT_MS = 30_000;
const CATEGORY = "Shipmate";

const linkCommand = new SlashCommandBuilder()
  .setName("shipmate")
  .setDescription("Shipmate")
  .addSubcommand((s) =>
    s
      .setName("link")
      .setDescription("Link your Discord account to your Shipmate account")
      .addStringOption((o) =>
        o
          .setName("code")
          .setDescription("The 6-digit code from Shipmate")
          .setRequired(true)
          .setMinLength(6)
          .setMaxLength(6),
      ),
  );

const STYLES: Record<BotButton["style"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** The real Discord, through discord.js v14. */
export class DiscordJsPort implements DiscordClientPort {
  #client: Client | null = null;
  #handler: (event: DiscordEvent) => void = () => {};
  #webhookClients = new Map<string, WebhookClient>();

  get connected(): boolean {
    return this.#client?.isReady() ?? false;
  }

  listen(handler: (event: DiscordEvent) => void): void {
    this.#handler = handler;
  }

  async connect(token: string): Promise<DiscordIdentity> {
    await this.disconnect();
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.#wire(client);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DiscordError("Discord did not answer in time. Try again.")),
        READY_TIMEOUT_MS,
      );
      client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      await client.login(token);
      await ready;
      const app = await client.application?.fetch();
      if (!app) throw new DiscordError("Discord did not say which application the bot is.");
      this.#client = client;
      return {
        applicationId: app.id,
        guilds: client.guilds.cache.map((g) => ({ id: g.id, name: g.name })),
      };
    } catch (err) {
      await client.destroy().catch(() => {});
      throw translate(err);
    }
  }

  async disconnect(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    for (const w of this.#webhookClients.values()) w.destroy();
    this.#webhookClients.clear();
    if (client) await client.destroy();
  }

  #wire(client: Client) {
    client.on(Events.MessageCreate, (m) => {
      this.#handler({
        type: "message",
        id: m.id,
        channelId: m.channelId,
        guildId: m.guildId,
        authorId: m.author.id,
        authorIsBot: m.author.bot,
        webhookId: m.webhookId ?? null,
        content: m.content,
      });
    });
    client.on(Events.InteractionCreate, (i) => {
      if (i.isChatInputCommand() && i.commandName === "shipmate") {
        if (i.options.getSubcommand(false) !== "link") return;
        this.#handler({
          type: "link_command",
          userId: i.user.id,
          channelId: i.channelId,
          guildId: i.guildId,
          code: i.options.getString("code", true),
          reply: async (content) => {
            await i.reply({ content, flags: MessageFlags.Ephemeral });
          },
        });
      } else if (i.isButton()) {
        this.#handler({
          type: "button",
          userId: i.user.id,
          channelId: i.channelId,
          messageId: i.message.id,
          customId: i.customId,
          reply: async (content) => {
            await i.reply({ content, flags: MessageFlags.Ephemeral });
          },
          acknowledge: async () => {
            await i.deferUpdate();
          },
        });
      }
    });
    // Emitted only when the shard gives up reconnecting (bad token, missing intent).
    client.on(Events.ShardDisconnect, (event) => {
      if (this.#client !== client) return;
      this.#handler({ type: "disconnected", error: closeReason(event.code) });
    });
    client.on(Events.Error, () => {});
  }

  #need(): Client {
    if (!this.#client) throw new DiscordError("The bot is not connected to Discord.");
    return this.#client;
  }

  async registerCommands(guildId: string): Promise<void> {
    const client = this.#need();
    try {
      await client.application?.commands.set([linkCommand.toJSON()], guildId);
    } catch (err) {
      throw translate(err, "Could not add the /shipmate command");
    }
  }

  async ensureCategoryAndChannels(
    guildId: string,
    specs: ChannelSpec[],
  ): Promise<Map<string, string>> {
    try {
      const guild = await this.#need().guilds.fetch(guildId);
      const all = [...(await guild.channels.fetch()).values()].filter((c) => c !== null);
      const category =
        all.find(
          (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "shipmate",
        ) ?? (await guild.channels.create({ name: CATEGORY, type: ChannelType.GuildCategory }));
      const out = new Map<string, string>();
      for (const spec of specs) {
        const found = all.find(
          (c) =>
            c.type === ChannelType.GuildText && c.parentId === category.id && c.name === spec.name,
        );
        const channel =
          found ??
          (await guild.channels.create({
            name: spec.name,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: spec.topic,
          }));
        out.set(spec.name, channel.id);
      }
      return out;
    } catch (err) {
      throw translate(err, "Could not create the Shipmate channels");
    }
  }

  async channelInfo(channelId: string): Promise<ChannelInfo | null> {
    const c = await this.#need()
      .channels.fetch(channelId)
      .catch(() => null);
    if (!c || c.isDMBased()) return null;
    return {
      id: c.id,
      name: c.name,
      guildId: c.guildId,
      text: c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement,
    };
  }

  channelName(channelId: string): string | null {
    const c = this.#client?.channels.cache.get(channelId);
    return c && !c.isDMBased() ? c.name : null;
  }

  async createWebhook(channelId: string, name: string): Promise<DiscordWebhook> {
    try {
      const c = await this.#need().channels.fetch(channelId);
      if (!c || (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildAnnouncement)) {
        throw new DiscordError("Pick a text channel.");
      }
      const webhook = await c.createWebhook({ name });
      if (!webhook.token) throw new DiscordError("Discord did not return a webhook token.");
      return { id: webhook.id, token: webhook.token };
    } catch (err) {
      throw translate(err, "Could not create a webhook");
    }
  }

  async sendWebhook(webhook: DiscordWebhook, message: WebhookMessage): Promise<void> {
    let client = this.#webhookClients.get(webhook.id);
    if (!client) {
      client = new WebhookClient({ id: webhook.id, token: webhook.token });
      this.#webhookClients.set(webhook.id, client);
    }
    await client.send({
      content: message.content,
      username: message.username.slice(0, 80),
      ...(message.avatarURL ? { avatarURL: message.avatarURL } : {}),
      allowedMentions: { parse: [], users: message.mentionUserIds },
    });
  }

  async sendBotMessage(channelId: string, message: BotMessage): Promise<string> {
    const channel = await this.#sendable(channelId);
    const sent = await channel.send({
      content: message.content,
      allowedMentions: { parse: [], users: message.mentionUserIds },
      components: rows(message.buttons),
    });
    return sent.id;
  }

  async editBotMessage(channelId: string, messageId: string, message: BotMessage): Promise<void> {
    const channel = await this.#sendable(channelId);
    await channel.messages.edit(messageId, {
      content: message.content,
      allowedMentions: { parse: [], users: message.mentionUserIds },
      components: rows(message.buttons),
    });
  }

  async reply(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.#sendable(channelId);
    await channel.send({
      content,
      reply: { messageReference: messageId, failIfNotExists: false },
      allowedMentions: { parse: [], repliedUser: true },
    });
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.#sendable(channelId);
    await channel.messages.react(messageId, emoji);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.#sendable(channelId);
    await channel.messages.delete(messageId);
  }

  async typing(channelId: string): Promise<void> {
    const channel = await this.#sendable(channelId);
    await channel.sendTyping();
  }

  async #sendable(channelId: string) {
    const c = await this.#need().channels.fetch(channelId);
    if (!c?.isSendable() || c.isDMBased()) {
      throw new DiscordError("That Discord channel is gone or the bot cannot post there.");
    }
    return c;
  }
}

function rows(buttons: BotButton[] | undefined) {
  if (!buttons?.length) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      buttons.map((b) =>
        new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(STYLES[b.style]),
      ),
    ),
  ];
}

function closeReason(code: number): string | null {
  if (code === 4004) return "Discord rejected the bot token.";
  if (code === 4014) return MESSAGE_CONTENT;
  if (code === 4013) return "Discord refused the bot's gateway intents.";
  return null;
}

const MESSAGE_CONTENT =
  "Enable the Message Content intent: Discord developer portal → your application → Bot → Privileged Gateway Intents.";

/** discord.js and Discord API errors, in plain words. Never includes the token. */
function translate(err: unknown, doing = "Could not connect to Discord"): DiscordError {
  if (err instanceof DiscordError) return err;
  const e = err as { code?: unknown; status?: unknown; message?: unknown };
  const code = e.code;
  const message = typeof e.message === "string" ? e.message : String(err);
  if (code === "TokenInvalid" || code === 4004 || /invalid token/i.test(message)) {
    return new DiscordError("Discord rejected the bot token.");
  }
  if (code === "DisallowedIntents" || code === 4014 || /disallowed intent/i.test(message)) {
    return new DiscordError(MESSAGE_CONTENT);
  }
  if (code === 50001 || code === 50013) {
    return new DiscordError(
      `${doing}: the bot is missing permissions. Re-invite it with the invite link.`,
    );
  }
  if (code === 10004) return new DiscordError(`${doing}: the bot is not in that Discord server.`);
  return new DiscordError(`${doing}: ${message}`);
}
