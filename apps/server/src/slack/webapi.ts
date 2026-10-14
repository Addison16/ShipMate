import {
  type SlackChannelInfo,
  SlackError,
  type SlackEvent,
  type SlackFile,
  type SlackIdentity,
  type SlackPort,
  type SlackPost,
  type SlackUpload,
} from "./port.js";
import { type Envelope, SocketAuthError, type SocketLike, SocketModeClient } from "./socket.js";

/** An error answer from Slack's Web API ({ ok: false, error }). */
export class SlackApiError extends SlackError {
  constructor(readonly code: string) {
    super(`Slack: ${code}`);
  }
}

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
]);

export interface SlackWebApiOptions {
  fetch?: typeof fetch;
  /** Default https://slack.com/api. */
  apiBase?: string;
  createSocket?: (url: string) => SocketLike;
  backoffMs?: (attempt: number) => number;
}

/** How many recent event ids to remember, to drop Slack's retries of the same event. */
const SEEN_EVENTS = 500;

/**
 * Slack's Web API over fetch plus a Socket Mode connection (no public URL needed). Rate
 * limited calls (429) are retried once after Slack's Retry-After.
 */
export class SlackWebApi implements SlackPort {
  #botToken = "";
  #appToken = "";
  #socket: SocketModeClient | null = null;
  #handler: (event: SlackEvent) => void = () => {};
  #names = new Map<string, string>();
  #seen = new Set<string>();
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(private readonly options: SlackWebApiOptions = {}) {
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#base = (options.apiBase ?? "https://slack.com/api").replace(/\/$/, "");
  }

  get connected(): boolean {
    return this.#socket?.connected ?? false;
  }

  listen(handler: (event: SlackEvent) => void) {
    this.#handler = handler;
  }

  async connect(botToken: string, appToken: string): Promise<SlackIdentity> {
    await this.disconnect();
    this.#botToken = botToken;
    this.#appToken = appToken;
    let me: { team_id: string; team: string; user_id: string };
    try {
      me = await this.#call("auth.test", {});
    } catch (err) {
      if (err instanceof SlackApiError && AUTH_ERRORS.has(err.code)) {
        throw new SlackError("Slack rejected the bot token (xoxb-…).");
      }
      throw err;
    }
    const socket = new SocketModeClient({
      openUrl: () => this.#openUrl(),
      ...(this.options.createSocket ? { createSocket: this.options.createSocket } : {}),
      ...(this.options.backoffMs ? { backoffMs: this.options.backoffMs } : {}),
      onEnvelope: (envelope) => this.#dispatch(envelope),
      onFatal: (error) => this.#emit({ type: "disconnected", error }),
    });
    this.#socket = socket;
    try {
      await socket.start();
    } catch (err) {
      this.#socket = null;
      if (err instanceof SocketAuthError) throw new SlackError(err.message);
      throw new SlackError(err instanceof Error ? err.message : String(err));
    }
    return { teamId: me.team_id, teamName: me.team, botUserId: me.user_id };
  }

  async disconnect() {
    this.#socket?.stop();
    this.#socket = null;
  }

  async postMessage(channelId: string, post: SlackPost): Promise<string> {
    const res = await this.#call<{ ts: string }>("chat.postMessage", {
      channel: channelId,
      ...postParams(post),
    });
    return res.ts;
  }

  async updateMessage(channelId: string, ts: string, post: SlackPost) {
    await this.#call("chat.update", { channel: channelId, ts, ...postParams(post) });
  }

  async uploadFiles(channelId: string, files: SlackFile[], options: SlackUpload = {}) {
    if (!files.length) return;
    const uploaded: { id: string; title: string }[] = [];
    for (const file of files) {
      const { upload_url: url, file_id: id } = await this.#call<{
        upload_url: string;
        file_id: string;
      }>("files.getUploadURLExternal", { filename: file.name, length: String(file.data.length) });
      if (!url.startsWith("https://")) throw new SlackError("Slack gave a bad upload address.");
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(file.data),
        });
      } catch (err) {
        throw new SlackError(
          `Could not reach Slack: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) throw new SlackApiError(`upload_http_${res.status}`);
      uploaded.push({ id, title: file.name });
    }
    await this.#call("files.completeUploadExternal", {
      files: uploaded,
      channel_id: channelId,
      thread_ts: options.threadTs,
      initial_comment: options.initialComment,
    });
  }

  async postEphemeral(channelId: string, userId: string, text: string) {
    await this.#call("chat.postEphemeral", { channel: channelId, user: userId, text });
  }

  async react(channelId: string, ts: string, emoji: string) {
    await this.#call("reactions.add", { channel: channelId, timestamp: ts, name: emoji });
  }

  async channelInfo(channelId: string): Promise<SlackChannelInfo | null> {
    try {
      const { channel } = await this.#call<{
        channel: {
          id: string;
          name?: string;
          is_member?: boolean;
          is_private?: boolean;
          is_im?: boolean;
        };
      }>("conversations.info", { channel: channelId });
      const name = channel.name ?? channel.id;
      this.#names.set(channel.id, name);
      return {
        id: channel.id,
        name,
        isMember: channel.is_member ?? false,
        isPrivate: channel.is_private ?? false,
        isIm: channel.is_im ?? false,
      };
    } catch (err) {
      if (err instanceof SlackApiError && err.code === "channel_not_found") return null;
      throw err;
    }
  }

  async joinChannel(channelId: string) {
    await this.#call("conversations.join", { channel: channelId });
  }

  channelName(channelId: string): string | null {
    return this.#names.get(channelId) ?? null;
  }

  // ---------- Socket Mode ----------

  async #openUrl(): Promise<string> {
    try {
      const res = await this.#call<{ url: string }>("apps.connections.open", {}, this.#appToken);
      return res.url;
    } catch (err) {
      if (err instanceof SlackApiError && AUTH_ERRORS.has(err.code)) {
        throw new SocketAuthError(
          "Slack rejected the app-level token (xapp-…). It needs the connections:write scope.",
        );
      }
      throw err;
    }
  }

  #dispatch(envelope: Envelope) {
    const payload = envelope.payload as Record<string, unknown>;
    if (envelope.type === "events_api") {
      const eventId = typeof payload.event_id === "string" ? payload.event_id : null;
      if (eventId) {
        if (this.#seen.has(eventId)) return;
        this.#seen.add(eventId);
        if (this.#seen.size > SEEN_EVENTS) {
          const oldest = this.#seen.values().next().value;
          if (oldest !== undefined) this.#seen.delete(oldest);
        }
      }
      const e = payload.event as Record<string, unknown> | undefined;
      if (e?.type !== "message") return;
      this.#emit({
        type: "message",
        channelId: str(e.channel),
        channelType: str(e.channel_type),
        userId: str(e.user),
        ts: str(e.ts),
        text: str(e.text),
        botId: typeof e.bot_id === "string" ? e.bot_id : null,
        subtype: typeof e.subtype === "string" ? e.subtype : null,
      });
      return;
    }
    if (envelope.type === "slash_commands") {
      const responseUrl = str(payload.response_url);
      this.#emit({
        type: "command",
        userId: str(payload.user_id),
        channelId: str(payload.channel_id),
        text: str(payload.text),
        respond: (text) => this.#respond(responseUrl, text),
      });
      return;
    }
    if (envelope.type === "interactive" && payload.type === "block_actions") {
      const user = payload.user as { id?: string } | undefined;
      const channel = payload.channel as { id?: string } | undefined;
      const container = payload.container as { message_ts?: string } | undefined;
      const actions = (payload.actions as { action_id?: string }[] | undefined) ?? [];
      const responseUrl = str(payload.response_url);
      for (const action of actions) {
        this.#emit({
          type: "button",
          userId: user?.id ?? "",
          channelId: channel?.id ?? null,
          messageTs: container?.message_ts ?? null,
          actionId: action.action_id ?? "",
          respond: (text) => this.#respond(responseUrl, text),
        });
      }
    }
  }

  async #respond(responseUrl: string, text: string) {
    if (!responseUrl.startsWith("https://")) return;
    await this.#fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
  }

  #emit(event: SlackEvent) {
    try {
      this.#handler(event);
    } catch {
      // The listener logs its own problems.
    }
  }

  // ---------- HTTP ----------

  async #call<T>(method: string, params: Record<string, unknown>, token = this.#botToken) {
    for (let attempt = 0; ; attempt++) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        form.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      let res: Response;
      try {
        res = await this.#fetch(`${this.#base}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        });
      } catch (err) {
        throw new SlackError(
          `Could not reach Slack: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (res.status === 429 && attempt === 0) {
        const wait = Number(res.headers.get("retry-after") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(30, Math.max(1, wait)) * 1000));
        continue;
      }
      let answer: { ok?: boolean; error?: string } & Record<string, unknown>;
      try {
        answer = (await res.json()) as typeof answer;
      } catch {
        throw new SlackApiError(`http_${res.status}`);
      }
      if (!answer.ok) throw new SlackApiError(answer.error ?? `http_${res.status}`);
      return answer as T;
    }
  }
}

function postParams(post: SlackPost): Record<string, unknown> {
  return {
    text: post.text,
    username: post.username,
    icon_url: post.iconUrl,
    icon_emoji: post.iconEmoji,
    blocks: post.blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
