import type {
  SlackChannelInfo,
  SlackEvent,
  SlackFile,
  SlackIdentity,
  SlackPort,
  SlackPost,
  SlackUpload,
} from "./port.js";
import { SlackError } from "./port.js";

/**
 * An in-memory Slack workspace for tests: channels, a record of everything the app posted, and
 * helpers that simulate people writing, using the slash command and pressing buttons.
 */
export class FakeSlackPort implements SlackPort {
  static readonly BOT_TOKEN = "xoxb-fake-bot-token";
  static readonly APP_TOKEN = "xapp-fake-app-token";
  readonly me: SlackIdentity = { teamId: "T0FAKE", teamName: "Test Harbor", botUserId: "U0BOT" };
  connected = false;
  channels = new Map<string, SlackChannelInfo>();
  joined: string[] = [];
  posts: (SlackPost & { channelId: string; ts: string })[] = [];
  updates: (SlackPost & { channelId: string; ts: string })[] = [];
  ephemerals: { channelId: string; userId: string; text: string }[] = [];
  uploads: (SlackUpload & { channelId: string; files: SlackFile[] })[] = [];
  reactions: { channelId: string; ts: string; emoji: string }[] = [];
  #handler: (event: SlackEvent) => void = () => {};
  #seq = 1000;

  #ts() {
    this.#seq += 1;
    return `1700000000.${String(this.#seq).padStart(6, "0")}`;
  }

  async connect(botToken: string, appToken: string): Promise<SlackIdentity> {
    if (botToken !== FakeSlackPort.BOT_TOKEN) {
      throw new SlackError("Slack rejected the bot token (xoxb-…).");
    }
    if (appToken !== FakeSlackPort.APP_TOKEN) {
      throw new SlackError("Slack rejected the app-level token (xapp-…).");
    }
    this.connected = true;
    return this.me;
  }
  async disconnect() {
    this.connected = false;
  }
  listen(handler: (event: SlackEvent) => void) {
    this.#handler = handler;
  }
  async postMessage(channelId: string, post: SlackPost) {
    const ts = this.#ts();
    this.posts.push({ ...post, channelId, ts });
    return ts;
  }
  async updateMessage(channelId: string, ts: string, post: SlackPost) {
    this.updates.push({ ...post, channelId, ts });
  }
  async uploadFiles(channelId: string, files: SlackFile[], options: SlackUpload = {}) {
    this.uploads.push({ ...options, channelId, files });
  }
  async postEphemeral(channelId: string, userId: string, text: string) {
    this.ephemerals.push({ channelId, userId, text });
  }
  async react(channelId: string, ts: string, emoji: string) {
    this.reactions.push({ channelId, ts, emoji });
  }
  async channelInfo(channelId: string) {
    return this.channels.get(channelId) ?? null;
  }
  async joinChannel(channelId: string) {
    const c = this.channels.get(channelId);
    if (!c) throw new SlackError("Slack: channel_not_found");
    c.isMember = true;
    this.joined.push(channelId);
  }
  channelName(channelId: string) {
    return this.channels.get(channelId)?.name ?? null;
  }

  // ---------- simulating people ----------

  addChannel(id: string, name: string, options: { private?: boolean; member?: boolean } = {}) {
    this.channels.set(id, {
      id,
      name,
      isMember: options.member ?? false,
      isPrivate: options.private ?? false,
      isIm: id.startsWith("D"),
    });
    return id;
  }

  /** Someone posts. Returns the message ts. */
  message(
    channelId: string,
    userId: string,
    text: string,
    options: { botId?: string; subtype?: string } = {},
  ): string {
    const ts = this.#ts();
    this.#handler({
      type: "message",
      channelId,
      channelType: channelId.startsWith("D") ? "im" : "channel",
      userId,
      ts,
      text,
      botId: options.botId ?? null,
      subtype: options.subtype ?? null,
    });
    return ts;
  }

  /** `/shipmate <text>`; resolves with the ephemeral reply. */
  command(userId: string, text: string, channelId = "C0GENERAL"): Promise<string> {
    return new Promise((resolve) => {
      this.#handler({
        type: "command",
        userId,
        channelId,
        text,
        respond: async (reply) => resolve(reply),
      });
    });
  }

  /** A button press; resolves with the ephemeral reply, or "acknowledged" after `settleMs`. */
  press(userId: string, channelId: string, messageTs: string, actionId: string, settleMs = 200) {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("acknowledged"), settleMs);
      this.#handler({
        type: "button",
        userId,
        channelId,
        messageTs,
        actionId,
        respond: async (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
      });
    });
  }

  /** The connection died for good (e.g. a token was revoked). */
  drop(error: string) {
    this.connected = false;
    this.#handler({ type: "disconnected", error });
  }
}
