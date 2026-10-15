/**
 * Everything Shipmate needs from Telegram, behind one small interface. The Bot API adapter
 * (botapi.ts) long-polls getUpdates over fetch; tests use FakeTelegramPort (fake.ts).
 */

/** A problem with Telegram, already phrased for the person reading the settings page. */
export class TelegramError extends Error {}

export interface TelegramIdentity {
  id: string;
  /** Without the @. */
  username: string;
  name: string;
}

export type TelegramChatKind = "private" | "group" | "supergroup" | "channel";

export interface TelegramChatInfo {
  id: string;
  title: string;
  kind: TelegramChatKind;
}

export interface TelegramButton {
  text: string;
  /** callback_data: at most 64 bytes. */
  data: string;
}

export interface TelegramOutgoing {
  /** Telegram HTML (parse_mode "HTML"), already escaped. */
  html: string;
  /** Rows of inline buttons; an empty array removes them on edit. */
  buttons?: TelegramButton[][];
  /** Reply to (quote) this message. */
  replyTo?: number;
}

/** A file to send. */
export interface TelegramFile {
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface TelegramFileOptions {
  /** "photo" shows it inline (sendPhoto); "document" sends the file as is (sendDocument). */
  as: "photo" | "document";
  /** Telegram HTML, already escaped. */
  captionHtml?: string;
  replyTo?: number;
}

/** Bots send photos up to 10 MB and other files up to 50 MB. */
export const TELEGRAM_PHOTO_LIMIT = 10 * 1024 * 1024;
export const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;

export type TelegramEvent =
  | {
      type: "message";
      chatId: string;
      chatKind: TelegramChatKind;
      /** Group title, or the person's name in a private chat. */
      chatTitle: string;
      messageId: number;
      fromId: string;
      fromIsBot: boolean;
      text: string;
    }
  | {
      /** A press on an inline button. */
      type: "callback";
      callbackId: string;
      fromId: string;
      chatId: string | null;
      messageId: number | null;
      data: string;
    }
  | {
      /** Polling stopped and will not resume by itself (the token was revoked). */
      type: "disconnected";
      error: string | null;
    };

export interface TelegramPort {
  /** Check the token, clear any webhook and start long polling. Throws TelegramError. */
  connect(token: string): Promise<TelegramIdentity>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  /** Called for every update. Replaces any earlier listener. */
  listen(handler: (event: TelegramEvent) => void): void;

  /** Returns the new message's id. */
  sendMessage(chatId: string, message: TelegramOutgoing): Promise<number>;
  editMessage(chatId: string, messageId: number, message: TelegramOutgoing): Promise<void>;
  /**
   * Upload a file (multipart). A photo Telegram turns down (odd sizes) goes as a document.
   * Returns the new message's id.
   */
  sendFile(chatId: string, file: TelegramFile, options: TelegramFileOptions): Promise<number>;
  /** Answer a button press; `text` shows as a short notice to the presser only. */
  answerCallback(callbackId: string, text: string | null): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  typing(chatId: string): Promise<void>;
  /** Null when the bot cannot see the chat. */
  chatInfo(chatId: string): Promise<TelegramChatInfo | null>;
}
