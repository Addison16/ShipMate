/**
 * Everything Shipmate needs from Slack, behind one small interface. The Web API + Socket Mode
 * adapter (webapi.ts, socket.ts) talks to Slack; tests use FakeSlackPort (fake.ts).
 */

/** A problem with Slack, already phrased for the person reading the settings page. */
export class SlackError extends Error {}

export interface SlackIdentity {
  teamId: string;
  teamName: string;
  botUserId: string;
}

export interface SlackChannelInfo {
  id: string;
  name: string;
  /** The app is in the channel (it can read and post there). */
  isMember: boolean;
  isPrivate: boolean;
  /** A direct message, not a channel. */
  isIm: boolean;
}

export interface SlackPost {
  /** mrkdwn, already escaped; also the notification fallback when blocks are set. */
  text: string;
  /** Post under this name instead of the app's (chat:write.customize). */
  username?: string;
  iconUrl?: string;
  /** ":anchor:" style. */
  iconEmoji?: string;
  /** Block Kit blocks; an empty array removes them on update. */
  blocks?: unknown[];
}

export type SlackEvent =
  | {
      type: "message";
      channelId: string;
      /** "channel", "group", "im" or "mpim". */
      channelType: string;
      userId: string;
      ts: string;
      text: string;
      /** Set when an app or bot (including our own posts) sent it. */
      botId: string | null;
      /** Edits, joins and the like carry a subtype; plain messages do not. */
      subtype: string | null;
    }
  | {
      /** `/shipmate <text>` */
      type: "command";
      userId: string;
      channelId: string;
      text: string;
      /** A reply only the person sees. */
      respond: (text: string) => Promise<void>;
    }
  | {
      /** A press on a Block Kit button. */
      type: "button";
      userId: string;
      channelId: string | null;
      messageTs: string | null;
      actionId: string;
      /** A reply only the presser sees. */
      respond: (text: string) => Promise<void>;
    }
  | {
      /** The connection is gone for good (a token was revoked). */
      type: "disconnected";
      error: string | null;
    };

export interface SlackPort {
  /** Check both tokens and open the Socket Mode connection. Throws SlackError. */
  connect(botToken: string, appToken: string): Promise<SlackIdentity>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  /** Called for every event. Replaces any earlier listener. */
  listen(handler: (event: SlackEvent) => void): void;

  /** Returns the message's ts. */
  postMessage(channelId: string, post: SlackPost): Promise<string>;
  updateMessage(channelId: string, ts: string, post: SlackPost): Promise<void>;
  postEphemeral(channelId: string, userId: string, text: string): Promise<void>;
  react(channelId: string, ts: string, emoji: string): Promise<void>;
  /** Null when the app cannot see the channel. */
  channelInfo(channelId: string): Promise<SlackChannelInfo | null>;
  joinChannel(channelId: string): Promise<void>;
  /** Cached channel name, for status pages; null when unknown. */
  channelName(channelId: string): string | null;
}
