import type { BridgeLinkCode, SlackChannelDto, SlackStatusDto } from "@shipmate/core";
import { CAPTAIN_SLUG } from "@shipmate/crew";
import { conversations, type Db, slackChannels, users } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";
import {
  BridgeListeners,
  BridgeStore,
  bridgeLog,
  deliver,
  LinkedAccounts,
  outcomeText,
} from "../chat/core.js";
import { ChatRelay, type ChatSink, type ChatTarget } from "../chat/relay.js";
import { splitMessage } from "../chat/split.js";
import type { ApprovalService } from "../services/approvals.js";
import type { CrewService } from "../services/crew.js";
import { escapeMrkdwn, SLACK_LIMIT, slackIcon, toMrkdwn } from "./format.js";
import { SlackError, type SlackEvent, type SlackIdentity, type SlackPort } from "./port.js";

const BOT_REF = "slack:bot";
const APP_REF = "slack:app";
const TEAM_KEY = "slack.teamId";

export const SLACK_LINK_HINT =
  "I don't know who you are yet. In Shipmate, open Chat bridges → Slack (under Manage), press “Get a link code”, then type `/shipmate link` with the code here.";

export interface SlackServiceDeps {
  db: Db;
  vault: SecretVault;
  crew: CrewService;
  bridge: Bridge;
  approvals: ApprovalService;
  port: SlackPort;
  log?: (message: string, err?: unknown) => void;
}

type MessageEvent = Extract<SlackEvent, { type: "message" }>;

/**
 * The Slack bridge: one app per instance over Socket Mode. Each crew member is bound to a
 * channel and posts there under its own name and icon; direct messages to the app go to the
 * Captain. Messages from linked people become turns in a conversation per channel and person;
 * their Bridge events come back through a ChatRelay.
 */
export class SlackService {
  readonly relay: ChatRelay;
  readonly accounts: LinkedAccounts;
  readonly #store: BridgeStore;
  readonly #listeners: BridgeListeners;
  readonly #log: (message: string, err?: unknown) => void;
  #me: SlackIdentity | null = null;
  #error: string | null = null;
  /** Channel id → crew slug. */
  #channels = new Map<string, string>();
  #targets = new Map<string, ChatTarget | null>();
  #avatars = new Map<string, string | null>();
  #hinted = new Set<string>();
  #lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SlackServiceDeps) {
    this.#log = deps.log ?? bridgeLog("slack");
    this.#store = new BridgeStore(deps.db, deps.vault);
    this.accounts = new LinkedAccounts(deps.db, "slackUserId", "Slack");
    this.relay = new ChatRelay(
      this.#sink(),
      {
        target: (id) => this.#target(id),
        userByExternalId: (id) => this.accounts.user(id),
        userName: (id) => this.#userName(id),
      },
      deps.approvals,
      { log: this.#log },
    );
    this.#listeners = new BridgeListeners(deps.bridge, (userId, event) =>
      this.relay.handle(userId, event),
    );
    deps.port.listen((event) => {
      this.#onEvent(event).catch((err) => this.#log(`could not handle a ${event.type}`, err));
    });
  }

  // ---------- lifecycle ----------

  /** Connect if both tokens are stored. Problems end up in status().error, never thrown. */
  start(): Promise<void> {
    return this.#serial(() => this.#connect());
  }

  stop(): Promise<void> {
    return this.#serial(() => this.#disconnect());
  }

  async #connect(): Promise<void> {
    await this.#disconnect();
    this.#error = null;
    const botToken = await this.#store.secret(BOT_REF);
    const appToken = await this.#store.secret(APP_REF);
    if (!botToken || !appToken) {
      if (botToken || appToken) {
        this.#error = botToken
          ? "Add the app-level token (xapp-…) to connect."
          : "Add the bot token (xoxb-…) to connect.";
      }
      return;
    }
    try {
      this.#me = await this.deps.port.connect(botToken, appToken);
      await this.#store.setSetting(TEAM_KEY, this.#me.teamId);
      await this.#loadChannels();
      for (const id of await this.accounts.linkedUserIds()) this.#listeners.listen(id);
    } catch (err) {
      this.#error = plain(err);
      this.#log("could not connect", err);
      await this.#disconnect();
    }
  }

  async #disconnect(): Promise<void> {
    this.#listeners.clear();
    this.relay.stop();
    this.#me = null;
    await this.deps.port.disconnect().catch((err) => this.#log("disconnect failed", err));
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(run, run);
    this.#lock = next.catch(() => {});
    return next;
  }

  // ---------- settings ----------

  async status(): Promise<SlackStatusDto> {
    const rows = new Map(
      (await this.deps.db.select().from(slackChannels)).map((r) => [r.crewSlug, r]),
    );
    const channels: SlackChannelDto[] = [];
    for (const c of await this.deps.crew.list(true)) {
      const row = rows.get(c.slug);
      if (!row && !(c.status === "active" && c.visibility === "shared")) continue;
      channels.push({
        crewSlug: c.slug,
        crewName: c.name,
        channelId: row?.channelId ?? null,
        channelName: row ? this.deps.port.channelName(row.channelId) : null,
      });
    }
    const hasBotToken = await this.#store.hasSecret(BOT_REF);
    const hasAppToken = await this.#store.hasSecret(APP_REF);
    return {
      configured: hasBotToken && hasAppToken,
      hasBotToken,
      hasAppToken,
      connected: this.deps.port.connected,
      teamId: this.#me?.teamId ?? (await this.#store.setting(TEAM_KEY)),
      teamName: this.#me?.teamName ?? null,
      botUserId: this.#me?.botUserId ?? null,
      error: this.#error,
      channels,
    };
  }

  /** Store new tokens, then reconnect. */
  async configure(input: { botToken?: string; appToken?: string }): Promise<SlackStatusDto> {
    const bot = input.botToken?.trim();
    const app = input.appToken?.trim();
    if (bot !== undefined && !/^xoxb-[\w-]+$/.test(bot)) {
      throw new HttpError(400, "botToken: paste the Bot User OAuth Token (starts with xoxb-)");
    }
    if (app !== undefined && !/^xapp-[\w-]+$/.test(app)) {
      throw new HttpError(400, "appToken: paste the app-level token (starts with xapp-)");
    }
    if (bot) await this.#store.putSecret(BOT_REF, bot);
    if (app) await this.#store.putSecret(APP_REF, app);
    await this.#serial(() => this.#connect());
    return this.status();
  }

  /** Disconnect and forget both tokens. Channel bindings and links stay. */
  async forget(): Promise<void> {
    await this.#serial(async () => {
      await this.#disconnect();
      await this.#store.deleteSecret(BOT_REF);
      await this.#store.deleteSecret(APP_REF);
      this.#error = null;
    });
  }

  /** Bind a crew member to an existing channel (the app joins public ones), or unbind it. */
  async bind(slug: string, channelId: string | null): Promise<SlackStatusDto> {
    await this.deps.crew.row(slug);
    if (channelId === null) {
      await this.deps.db.delete(slackChannels).where(eq(slackChannels.crewSlug, slug));
    } else {
      if (!this.deps.port.connected) throw new HttpError(409, "Connect the app to Slack first.");
      const [taken] = await this.deps.db
        .select()
        .from(slackChannels)
        .where(eq(slackChannels.channelId, channelId));
      if (taken && taken.crewSlug !== slug) {
        throw new HttpError(409, `That channel already belongs to ${taken.crewSlug}.`);
      }
      try {
        const info = await this.deps.port.channelInfo(channelId);
        if (!info) {
          throw new HttpError(
            400,
            "Shipmate cannot see that channel. For a private channel, invite the app first (/invite @Shipmate).",
          );
        }
        if (info.isIm) throw new HttpError(400, "Pick a channel, not a direct message.");
        if (!info.isMember) {
          if (info.isPrivate) {
            throw new HttpError(
              400,
              "Invite the app to that private channel first (/invite @Shipmate).",
            );
          }
          await this.deps.port.joinChannel(channelId);
        }
      } catch (err) {
        if (err instanceof SlackError) throw new HttpError(502, err.message);
        throw err;
      }
      const values = { channelId, updatedAt: new Date() };
      await this.deps.db
        .insert(slackChannels)
        .values({ crewSlug: slug, ...values })
        .onConflictDoUpdate({ target: slackChannels.crewSlug, set: values });
    }
    await this.#loadChannels();
    return this.status();
  }

  async #loadChannels() {
    const rows = await this.deps.db.select().from(slackChannels);
    this.#channels = new Map(rows.map((r) => [r.channelId, r.crewSlug]));
    this.#avatars.clear();
    if (this.deps.port.connected) {
      // Warm the name cache for the status page.
      await Promise.all(rows.map((r) => this.deps.port.channelInfo(r.channelId).catch(() => null)));
    }
  }

  // ---------- linking ----------

  issueLinkCode(user: UserRow): BridgeLinkCode {
    const { code, expiresAt } = this.accounts.codes.issue(user.id);
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      instructions: `In Slack, type /shipmate link ${code} (or send "!link ${code}" in a crew channel or to the app). The code works once, for 10 minutes.`,
    };
  }

  async unlink(user: UserRow): Promise<void> {
    await this.accounts.unlink(user.id);
    this.#listeners.drop(user.id);
  }

  async linkFromSlack(slackUserId: string, code: string): Promise<string> {
    const { reply, user } = await this.accounts.link(slackUserId, code);
    if (user) {
      this.#hinted.delete(slackUserId);
      if (this.deps.port.connected) this.#listeners.listen(user.id);
    }
    return reply;
  }

  // ---------- Slack events ----------

  async #onEvent(event: SlackEvent): Promise<void> {
    switch (event.type) {
      case "message":
        return this.#onMessage(event);
      case "command": {
        const code = /^link\s+(\d{6})$/i.exec(event.text.trim())?.[1];
        await event.respond(
          code
            ? await this.linkFromSlack(event.userId, code)
            : "Usage: /shipmate link 123456 (get the code on Shipmate's Slack page). To talk to the crew, write in a crew channel or message the app.",
        );
        return;
      }
      case "button": {
        const reply = await this.relay.click(event.userId, event.actionId);
        if (reply) await event.respond(reply);
        return;
      }
      case "disconnected": {
        await this.#serial(() => this.#disconnect());
        this.#error = event.error ?? "Lost the connection to Slack.";
        return;
      }
    }
  }

  async #onMessage(m: MessageEvent): Promise<void> {
    if (m.botId || m.subtype || !m.userId || m.userId === this.#me?.botUserId) return;
    const isIm = m.channelType === "im";
    const slug = this.#channels.get(m.channelId) ?? (isIm ? CAPTAIN_SLUG : null);
    if (!slug) return;
    const port = this.deps.port;
    const tell = (text: string) =>
      isIm
        ? port.postMessage(m.channelId, { text: escapeMrkdwn(text) }).then(() => {})
        : port.postEphemeral(m.channelId, m.userId, escapeMrkdwn(text));
    const text = m.text.trim();

    const link = /^!?link\s+(\d{6})$/i.exec(text);
    if (link?.[1] && (isIm || text.startsWith("!"))) {
      await tell(await this.linkFromSlack(m.userId, link[1]));
      return;
    }

    const user = await this.accounts.user(m.userId);
    if (!user) {
      if (this.#hinted.has(m.userId)) return;
      this.#hinted.add(m.userId);
      await tell(SLACK_LINK_HINT);
      return;
    }
    if (!text) return;

    const typed = this.relay.answer(m.channelId, user.id, text);
    if (typed.handled) {
      if (typed.reply) await tell(typed.reply);
      return;
    }

    const outcome = await deliver(this.deps, {
      user,
      slug,
      text,
      surface: "slack",
      externalId: `${m.channelId}:${m.userId}:${slug}`,
      title: (name) => `Slack: ${name}`,
      onConversation: (id) => {
        this.#targets.set(id, { chatId: m.channelId, externalUserId: m.userId });
      },
    });
    if (outcome.kind === "sent") return;
    if (outcome.kind === "busy") {
      await port.react(m.channelId, m.ts, "hourglass_flowing_sand").catch(() => {});
    }
    if (outcome.kind === "failed" && outcome.serverError) this.#log("send failed", outcome.message);
    await tell(outcomeText(outcome));
  }

  // ---------- posting ----------

  #sink(): ChatSink {
    const port = this.deps.port;
    const isIm = (chatId: string) => chatId.startsWith("D");
    return {
      postCrew: async (t, crew, text, mention) => {
        const prefix = mention && !isIm(t.chatId) ? `<@${t.externalUserId}> ` : "";
        const icon = slackIcon(await this.#avatar(crew.slug));
        for (const [i, chunk] of splitMessage(text, SLACK_LIMIT - prefix.length).entries()) {
          await port.postMessage(t.chatId, {
            text: `${i === 0 ? prefix : ""}${toMrkdwn(chunk)}`,
            username: crew.name,
            ...icon,
          });
        }
      },
      postHandoff: async (t, from, to, task) => {
        await port.postMessage(t.chatId, {
          text: `_${escapeMrkdwn(`${from.name} asked ${to.name}: ${task}`)}_`,
          username: from.name,
          ...slackIcon(await this.#avatar(from.slug)),
        });
      },
      postError: async (t, message) => {
        await port.postMessage(t.chatId, { text: `:warning: ${escapeMrkdwn(message)}` });
      },
      postApproval: async (t, card) => {
        const mention = isIm(t.chatId) ? "" : `<@${t.externalUserId}> `;
        const text = `${mention}*${escapeMrkdwn(card.summary)}*`;
        return port.postMessage(t.chatId, {
          text,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: card.question
                  ? `${text}\n${escapeMrkdwn(card.detail)}`
                  : `${text}\n\`\`\`${escapeMrkdwn(card.detail)}\`\`\``,
              },
            },
            {
              type: "actions",
              elements: card.buttons.map((b) => ({
                type: "button",
                action_id: b.actionId,
                text: { type: "plain_text", text: b.label },
                ...(card.question
                  ? {}
                  : b.decision === "allow"
                    ? { style: "primary" }
                    : b.decision === "deny"
                      ? { style: "danger" }
                      : {}),
              })),
            },
          ],
        });
      },
      resolveApproval: async (chatId, ts, summary, outcome) => {
        const text = `*${escapeMrkdwn(summary)}*\n${escapeMrkdwn(outcome)}`;
        await port.updateMessage(chatId, ts, {
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        });
      },
    };
  }

  // ---------- lookups ----------

  async #avatar(slug: string): Promise<string | null> {
    if (this.#avatars.has(slug)) return this.#avatars.get(slug) ?? null;
    let avatar: string | null = null;
    try {
      avatar = this.deps.crew.folder(slug).manifest.avatar ?? null;
    } catch {
      avatar = null;
    }
    this.#avatars.set(slug, avatar);
    return avatar;
  }

  async #target(conversationId: string): Promise<ChatTarget | null> {
    if (this.#targets.has(conversationId)) return this.#targets.get(conversationId) ?? null;
    const [c] = await this.deps.db
      .select({ surface: conversations.surface, externalId: conversations.externalId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    let target: ChatTarget | null = null;
    if (c?.surface === "slack" && c.externalId) {
      const [chatId, externalUserId] = c.externalId.split(":");
      if (chatId && externalUserId) target = { chatId, externalUserId };
    }
    this.#targets.set(conversationId, target);
    return target;
  }

  async #userName(id: string): Promise<string> {
    const [u] = await this.deps.db.select().from(users).where(eq(users.id, id)).limit(1);
    return u?.displayName ?? "the person who asked";
  }
}

function plain(err: unknown): string {
  if (err instanceof SlackError) return err.message;
  return `Slack request failed: ${err instanceof Error ? err.message : String(err)}`;
}
