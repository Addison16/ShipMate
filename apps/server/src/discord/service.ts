import type { DiscordChannelDto, DiscordLinkCode, DiscordStatusDto } from "@shipmate/core";
import { CAPTAIN_SLUG } from "@shipmate/crew";
import { conversations, type Db, discordChannels, secrets, settings, users } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { and, eq, isNotNull } from "drizzle-orm";
import { HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";
import { watchReportText } from "../chat/core.js";
import type { ApprovalService } from "../services/approvals.js";
import type { CrewService } from "../services/crew.js";
import type { WatchReport } from "../services/watches.js";
import { LinkCodes } from "./link-codes.js";
import {
  type ChannelSpec,
  type DiscordClientPort,
  DiscordError,
  type DiscordEvent,
  type DiscordWebhook,
} from "./port.js";
import { DiscordRelay, type RelayTarget } from "./relay.js";

const BOT_REF = "discord:bot";
const webhookRef = (slug: string) => `discord:webhook:${slug}`;
const GUILD_KEY = "discord.guildId";
const APP_KEY = "discord.applicationId";

/** ManageChannels | ViewChannel | SendMessages | ManageMessages | EmbedLinks |
 * ReadMessageHistory | AddReactions | ManageWebhooks. ManageMessages removes `!link` messages
 * (they hold a code); AddReactions marks a message that arrived while the crew was busy. */
export const BOT_PERMISSIONS =
  (1 << 4) + (1 << 10) + (1 << 11) + (1 << 13) + (1 << 14) + (1 << 16) + (1 << 6) + (1 << 29);

export const inviteUrl = (applicationId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`;

export const LINK_HINT =
  "I don't know who you are yet. In Shipmate, open Chat bridges → Discord (under Manage) and press **Get a link code**, then type `/shipmate link` here with the code it shows.";

export interface DiscordServiceDeps {
  db: Db;
  vault: SecretVault;
  crew: CrewService;
  bridge: Bridge;
  approvals: ApprovalService;
  port: DiscordClientPort;
  log?: (message: string, err?: unknown) => void;
}

/**
 * The Discord bridge: one bot per instance, a channel and webhook per crew member, linked
 * Discord accounts mapped to Shipmate people. Messages in a crew channel become turns in a
 * Shipmate conversation (one per channel and person); that person's Bridge events flow back
 * through the DiscordRelay while the bot is connected.
 */
export class DiscordService {
  readonly relay: DiscordRelay;
  readonly codes = new LinkCodes();
  #error: string | null = null;
  #guildName: string | null = null;
  /** Channel id → crew slug, for the crew channels. */
  #channels = new Map<string, string>();
  /** Bridge listener per linked person, while connected. */
  #listeners = new Map<string, () => void>();
  #targets = new Map<string, RelayTarget | null>();
  #webhooks = new Map<string, DiscordWebhook | null>();
  /** Unlinked accounts that have been told how to link (once each). */
  #hinted = new Set<string>();
  #lock: Promise<unknown> = Promise.resolve();
  readonly #log: (message: string, err?: unknown) => void;

  constructor(private readonly deps: DiscordServiceDeps) {
    this.#log =
      deps.log ??
      ((message, err) =>
        console.error(
          `[discord] ${message}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}`,
        ));
    this.relay = new DiscordRelay(
      deps.port,
      {
        target: (id) => this.#target(id),
        webhook: (channelId) => this.#webhook(channelId),
        userByDiscordId: (id) => this.#userByDiscordId(id),
        userName: async (id) => {
          const [u] = await deps.db.select().from(users).where(eq(users.id, id)).limit(1);
          return u?.displayName ?? "the person who asked";
        },
      },
      deps.approvals,
      this.#log,
    );
    deps.port.listen((event) => {
      this.#onEvent(event).catch((err) => this.#log(`could not handle a ${event.type}`, err));
    });
  }

  // ---------- lifecycle ----------

  /** Connect if a bot token is stored. Problems end up in status().error, never thrown. */
  start(): Promise<void> {
    return this.#serial(() => this.#connect());
  }

  stop(): Promise<void> {
    return this.#serial(() => this.#disconnect());
  }

  async #connect(): Promise<void> {
    await this.#disconnect();
    const token = await this.#secret(BOT_REF);
    this.#error = null;
    if (!token) return;
    try {
      const me = await this.deps.port.connect(token);
      await this.#setSetting(APP_KEY, me.applicationId);
      let guildId = await this.#setting(GUILD_KEY);
      const only = me.guilds.length === 1 ? me.guilds[0] : undefined;
      if (!guildId && only) {
        guildId = only.id;
        await this.#setSetting(GUILD_KEY, guildId);
      }
      const guild = me.guilds.find((g) => g.id === guildId);
      this.#guildName = guild?.name ?? null;
      if (!guildId) {
        this.#error = me.guilds.length
          ? "The bot is in several Discord servers; choose which one Shipmate uses."
          : "Add the bot to your Discord server with the invite link, then save again.";
      } else if (!guild) {
        this.#error =
          "The bot is not in the chosen Discord server. Add it with the invite link, then save again.";
      } else {
        await this.deps.port.registerCommands(guild.id);
      }
      await this.#loadChannels();
      const linked = await this.deps.db
        .select({ id: users.id })
        .from(users)
        .where(isNotNull(users.discordUserId));
      for (const u of linked) this.#listen(u.id);
    } catch (err) {
      this.#error = plain(err);
      this.#log("could not connect", err);
      if (!this.deps.port.connected) await this.#disconnect();
    }
  }

  async #disconnect(): Promise<void> {
    for (const off of this.#listeners.values()) off();
    this.#listeners.clear();
    this.relay.stop();
    this.#guildName = null;
    await this.deps.port.disconnect().catch((err) => this.#log("disconnect failed", err));
  }

  #listen(userId: string) {
    if (this.#listeners.has(userId) || !this.deps.port.connected) return;
    const off = this.deps.bridge.connect(userId, (event) => this.relay.handle(userId, event));
    this.#listeners.set(userId, off);
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(run, run);
    this.#lock = next.catch(() => {});
    return next;
  }

  /**
   * A finished watch's result, posted in that crew member's channel (else the Captain's) with
   * a mention of its owner, where they already talk to that crew member.
   */
  async report(r: WatchReport): Promise<void> {
    if (!this.deps.port.connected) return;
    const [u] = await this.deps.db
      .select({ discordUserId: users.discordUserId })
      .from(users)
      .where(eq(users.id, r.userId))
      .limit(1);
    if (!u?.discordUserId) return;
    const byCrew = new Map([...this.#channels].map(([channelId, slug]) => [slug, channelId]));
    const channelId = byCrew.get(r.crew.slug) ?? byCrew.get(CAPTAIN_SLUG);
    if (!channelId) return;
    this.relay.post(
      { channelId, discordUserId: u.discordUserId },
      r.crew.name,
      watchReportText(r.watchName, r.text),
    );
  }

  // ---------- settings ----------

  async status(): Promise<DiscordStatusDto> {
    const [configured] = await this.deps.db
      .select({ ref: secrets.ref })
      .from(secrets)
      .where(eq(secrets.ref, BOT_REF));
    const applicationId = await this.#setting(APP_KEY);
    const rows = new Map(
      (await this.deps.db.select().from(discordChannels)).map((r) => [r.crewSlug, r]),
    );
    const all = await this.deps.crew.list(true);
    const channels: DiscordChannelDto[] = [];
    for (const c of all) {
      const row = rows.get(c.slug);
      if (!row && !crewGetsChannel(c)) continue;
      channels.push({
        crewSlug: c.slug,
        crewName: c.name,
        channelId: row?.channelId ?? null,
        channelName: row ? this.deps.port.channelName(row.channelId) : null,
        webhook: Boolean(row?.webhookId && row.webhookTokenRef),
      });
    }
    return {
      configured: Boolean(configured),
      connected: this.deps.port.connected,
      applicationId,
      guildId: await this.#setting(GUILD_KEY),
      guildName: this.#guildName,
      error: this.#error,
      inviteUrl: applicationId ? inviteUrl(applicationId) : null,
      channels,
    };
  }

  /** Store a new token and/or server, then reconnect. */
  async configure(input: { botToken?: string; guildId?: string }): Promise<DiscordStatusDto> {
    if (input.botToken !== undefined) {
      const token = input.botToken.trim();
      if (!token) throw new HttpError(400, "botToken: paste the bot token");
      await this.#putSecret(BOT_REF, token);
    }
    if (input.guildId !== undefined) {
      if (input.guildId) await this.#setSetting(GUILD_KEY, input.guildId);
      else await this.deps.db.delete(settings).where(eq(settings.key, GUILD_KEY));
    }
    await this.#serial(() => this.#connect());
    return this.status();
  }

  /** Disconnect and forget the bot token. Channels and links stay for a later reconnect. */
  async forget(): Promise<void> {
    await this.#serial(async () => {
      await this.#disconnect();
      await this.deps.db.delete(secrets).where(eq(secrets.ref, BOT_REF));
      this.#error = null;
    });
  }

  // ---------- channels ----------

  /** Create the category, a channel per active shared crew member, and missing webhooks. */
  async sync(): Promise<DiscordStatusDto> {
    const guildId = await this.#readyGuild();
    try {
      const crew = (await this.deps.crew.list(false)).filter(crewGetsChannel);
      const rows = new Map(
        (await this.deps.db.select().from(discordChannels)).map((r) => [r.crewSlug, r]),
      );
      const channelOf = new Map<string, string>();
      const missing: ChannelSpec[] = [];
      for (const c of crew) {
        const row = rows.get(c.slug);
        const info = row ? await this.deps.port.channelInfo(row.channelId) : null;
        if (row && info) channelOf.set(c.slug, row.channelId);
        else missing.push({ name: c.slug, topic: c.role.slice(0, 1024) });
      }
      if (missing.length) {
        const made = await this.deps.port.ensureCategoryAndChannels(guildId, missing);
        for (const [slug, channelId] of made) channelOf.set(slug, channelId);
      }
      for (const c of crew) {
        const channelId = channelOf.get(c.slug);
        if (!channelId) continue;
        const row = rows.get(c.slug);
        const intact =
          row?.channelId === channelId &&
          row.webhookId &&
          row.webhookTokenRef &&
          (await this.#secret(row.webhookTokenRef));
        if (!intact) await this.#attach(c.slug, channelId);
      }
      this.#error = null;
    } catch (err) {
      if (!(err instanceof DiscordError)) throw err;
      this.#error = err.message;
    }
    await this.#loadChannels();
    return this.status();
  }

  /** Bind a crew member to an existing channel (a webhook is created there), or unbind it. */
  async bind(slug: string, channelId: string | null): Promise<DiscordStatusDto> {
    await this.deps.crew.row(slug);
    if (channelId === null) {
      await this.deps.db.delete(discordChannels).where(eq(discordChannels.crewSlug, slug));
      await this.deps.db.delete(secrets).where(eq(secrets.ref, webhookRef(slug)));
    } else {
      const guildId = await this.#readyGuild();
      const [taken] = await this.deps.db
        .select()
        .from(discordChannels)
        .where(eq(discordChannels.channelId, channelId));
      if (taken && taken.crewSlug !== slug) {
        throw new HttpError(409, `That channel already belongs to ${taken.crewSlug}.`);
      }
      if (!taken?.webhookId) {
        const info = await this.deps.port.channelInfo(channelId);
        if (!info || info.guildId !== guildId) {
          throw new HttpError(400, "That channel is not in the connected Discord server.");
        }
        if (!info.text) throw new HttpError(400, "Pick a text channel.");
        try {
          await this.#attach(slug, channelId);
        } catch (err) {
          if (err instanceof DiscordError) throw new HttpError(502, err.message);
          throw err;
        }
      }
    }
    await this.#loadChannels();
    return this.status();
  }

  async #attach(slug: string, channelId: string) {
    const webhook = await this.deps.port.createWebhook(channelId, "Shipmate");
    const ref = webhookRef(slug);
    await this.#putSecret(ref, webhook.token);
    const values = {
      channelId,
      webhookId: webhook.id,
      webhookTokenRef: ref,
      updatedAt: new Date(),
    };
    await this.deps.db
      .insert(discordChannels)
      .values({ crewSlug: slug, ...values })
      .onConflictDoUpdate({ target: discordChannels.crewSlug, set: values });
  }

  async #readyGuild(): Promise<string> {
    if (!this.deps.port.connected) throw new HttpError(409, "Connect the bot to Discord first.");
    const guildId = await this.#setting(GUILD_KEY);
    if (!guildId || !this.#guildName) {
      throw new HttpError(409, this.#error ?? "Choose the Discord server Shipmate uses first.");
    }
    return guildId;
  }

  async #loadChannels() {
    const rows = await this.deps.db.select().from(discordChannels);
    this.#channels = new Map(rows.map((r) => [r.channelId, r.crewSlug]));
    this.#webhooks.clear();
  }

  // ---------- linking ----------

  issueLinkCode(user: UserRow): DiscordLinkCode {
    const { code, expiresAt } = this.codes.issue(user.id);
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      instructions: `In your Discord server, type /shipmate link and enter the code ${code} (or send "!link ${code}" in a crew channel). The code works once, for 10 minutes.`,
    };
  }

  async unlink(user: UserRow): Promise<void> {
    await this.deps.db.update(users).set({ discordUserId: null }).where(eq(users.id, user.id));
    this.#listeners.get(user.id)?.();
    this.#listeners.delete(user.id);
  }

  /** Link the Discord account that typed `code`. Returns the reply to show in Discord. */
  async linkFromDiscord(discordUserId: string, code: string): Promise<string> {
    const userId = this.codes.consume(code);
    if (!userId) return "That code is not valid or has expired. Make a new one in Shipmate.";
    const existing = await this.#userByDiscordId(discordUserId);
    if (existing && existing.id !== userId) {
      return `This Discord account is already linked to ${existing.displayName}. Unlink it in Shipmate first.`;
    }
    let linked: UserRow | undefined;
    try {
      [linked] = await this.deps.db
        .update(users)
        .set({ discordUserId })
        .where(eq(users.id, userId))
        .returning();
    } catch {
      return "This Discord account is already linked to someone else.";
    }
    if (!linked) return "That Shipmate account no longer exists.";
    this.#hinted.delete(discordUserId);
    this.#listen(linked.id);
    return `Linked to ${linked.displayName}'s Shipmate account. Talk to the crew in their channels.`;
  }

  // ---------- Discord events ----------

  async #onEvent(event: DiscordEvent): Promise<void> {
    switch (event.type) {
      case "message":
        return this.#onMessage(event);
      case "link_command":
        return event.reply(await this.linkFromDiscord(event.userId, event.code));
      case "button":
        return this.relay.button(event);
      case "disconnected": {
        const error = event.error ?? "Lost the connection to Discord.";
        await this.#serial(() => this.#disconnect());
        this.#error = error;
        return;
      }
    }
  }

  async #onMessage(m: Extract<DiscordEvent, { type: "message" }>): Promise<void> {
    if (m.authorIsBot || m.webhookId) return;
    const slug = this.#channels.get(m.channelId);
    if (!slug) return;
    const port = this.deps.port;
    const text = m.content.trim();

    const link = /^!link\s+(\d{6})$/i.exec(text);
    if (link?.[1]) {
      const answer = await this.linkFromDiscord(m.authorId, link[1]);
      await port.deleteMessage(m.channelId, m.id).catch((err) => this.#log("delete failed", err));
      await port.sendBotMessage(m.channelId, {
        content: `<@${m.authorId}> ${answer}`,
        mentionUserIds: [m.authorId],
      });
      return;
    }

    // Reloaded per message, so role and cap changes apply right away.
    const user = await this.#userByDiscordId(m.authorId);
    if (!user) {
      if (this.#hinted.has(m.authorId)) return;
      this.#hinted.add(m.authorId);
      await port.reply(m.channelId, m.id, LINK_HINT);
      return;
    }
    if (!text) return;

    const typed = this.relay.answer(m.channelId, user.id, text);
    if (typed.handled) {
      if (typed.reply) await port.reply(m.channelId, m.id, typed.reply);
      return;
    }

    let crew: Awaited<ReturnType<CrewService["assertVisible"]>>;
    try {
      crew = await this.deps.crew.assertVisible(slug, user);
    } catch {
      await port.reply(m.channelId, m.id, "This crew member is not available to you.");
      return;
    }
    if (crew.status !== "active") {
      await port.reply(m.channelId, m.id, `${crew.name} is not taking messages right now.`);
      return;
    }

    const conversationId = await this.#conversationFor(user, m.channelId, m.authorId, crew);
    try {
      await this.deps.bridge.send(user, conversationId, text);
    } catch (err) {
      const status = err instanceof HttpError ? err.statusCode : 500;
      if (status === 409) {
        await port.react(m.channelId, m.id, "⏳").catch(() => {});
        await port.reply(
          m.channelId,
          m.id,
          `${crew.name} is still answering your last message. Send this again once it's done.`,
        );
      } else {
        await port.reply(
          m.channelId,
          m.id,
          err instanceof HttpError ? err.message : "Something went wrong on the server.",
        );
        if (status >= 500) this.#log("send failed", err);
      }
    }
  }

  async #conversationFor(
    user: UserRow,
    channelId: string,
    discordUserId: string,
    crew: { slug: string; name: string; captain: boolean },
  ): Promise<string> {
    const externalId = `${channelId}:${discordUserId}`;
    const [found] = await this.deps.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.surface, "discord"),
          eq(conversations.externalId, externalId),
          eq(conversations.userId, user.id),
        ),
      )
      .limit(1);
    const id =
      found?.id ??
      (
        await this.deps.bridge.createConversation(user, {
          kind: crew.captain ? "bridge" : "direct",
          crewSlug: crew.slug,
          surface: "discord",
          externalId,
          title: `Discord: ${crew.name}`,
        })
      ).id;
    this.#targets.set(id, { channelId, discordUserId });
    return id;
  }

  // ---------- lookups ----------

  async #target(conversationId: string): Promise<RelayTarget | null> {
    if (this.#targets.has(conversationId)) return this.#targets.get(conversationId) ?? null;
    const [c] = await this.deps.db
      .select({ surface: conversations.surface, externalId: conversations.externalId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    let target: RelayTarget | null = null;
    if (c?.surface === "discord" && c.externalId) {
      const [channelId, discordUserId] = c.externalId.split(":");
      if (channelId && discordUserId) target = { channelId, discordUserId };
    }
    this.#targets.set(conversationId, target);
    return target;
  }

  async #webhook(channelId: string): Promise<DiscordWebhook | null> {
    if (this.#webhooks.has(channelId)) return this.#webhooks.get(channelId) ?? null;
    const [row] = await this.deps.db
      .select()
      .from(discordChannels)
      .where(eq(discordChannels.channelId, channelId))
      .limit(1);
    const token = row?.webhookTokenRef ? await this.#secret(row.webhookTokenRef) : null;
    const webhook = row?.webhookId && token ? { id: row.webhookId, token } : null;
    this.#webhooks.set(channelId, webhook);
    return webhook;
  }

  async #userByDiscordId(discordUserId: string): Promise<UserRow | null> {
    const [u] = await this.deps.db
      .select()
      .from(users)
      .where(eq(users.discordUserId, discordUserId))
      .limit(1);
    return u ?? null;
  }

  // ---------- storage ----------

  async #secret(ref: string): Promise<string | null> {
    const [s] = await this.deps.db.select().from(secrets).where(eq(secrets.ref, ref)).limit(1);
    if (!s) return null;
    try {
      return this.deps.vault.decrypt(s.ciphertext);
    } catch {
      return null;
    }
  }

  async #putSecret(ref: string, value: string) {
    const ciphertext = this.deps.vault.encrypt(value);
    await this.deps.db
      .insert(secrets)
      .values({ ref, ciphertext })
      .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
  }

  /**
   * Discord ids are stored as { id } rather than a bare JSON string: the jsonb column's reader
   * parses an all-digit string a second time, into a number that loses precision.
   */
  async #setting(key: string): Promise<string | null> {
    const [row] = await this.deps.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    const value = row?.value as { id?: unknown } | undefined;
    return typeof value?.id === "string" ? value.id : null;
  }

  async #setSetting(key: string, id: string) {
    const value = { id };
    await this.deps.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

/** Private crew members get no channel of their own: everyone in the server could read it. */
function crewGetsChannel(c: { status: string; visibility: string }): boolean {
  return c.status === "active" && c.visibility === "shared";
}

function plain(err: unknown): string {
  if (err instanceof DiscordError) return err.message;
  return `Discord request failed: ${err instanceof Error ? err.message : String(err)}`;
}
