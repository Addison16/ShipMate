import type { SlackStatusDto, TelegramStatusDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  bridgeTab,
  isSlackChannelId,
  isTelegramChatId,
  SLACK_MANIFEST,
  slackState,
  telegramState,
} from "./bridges.js";

const telegram: TelegramStatusDto = {
  configured: true,
  connected: true,
  botUsername: "ship_bot",
  botUrl: "https://t.me/ship_bot",
  error: null,
  chats: [],
  seenChats: [],
};

const slack: SlackStatusDto = {
  configured: true,
  hasBotToken: true,
  hasAppToken: true,
  connected: true,
  teamId: "T1",
  teamName: "Harbor",
  botUserId: "U1",
  error: null,
  channels: [],
};

describe("bridge tabs", () => {
  it("falls back to Discord", () => {
    expect(bridgeTab("slack")).toBe("slack");
    expect(bridgeTab("nope")).toBe("discord");
    expect(bridgeTab(null)).toBe("discord");
  });
});

describe("telegramState", () => {
  it("describes each state", () => {
    expect(telegramState({ ...telegram, configured: false, connected: false }).label).toBe(
      "not set up",
    );
    expect(telegramState(telegram)).toMatchObject({
      tone: "ok",
      detail: "Listening as @ship_bot.",
    });
    expect(
      telegramState({ ...telegram, connected: false, error: "Telegram rejected the bot token." }),
    ).toMatchObject({ tone: "danger", detail: "Telegram rejected the bot token." });
  });
});

describe("slackState", () => {
  it("describes each state", () => {
    expect(slackState({ ...slack, hasBotToken: false, hasAppToken: false }).label).toBe(
      "not set up",
    );
    expect(slackState(slack).detail).toBe('Connected to the "Harbor" workspace.');
    expect(
      slackState({ ...slack, configured: false, hasAppToken: false, connected: false }),
    ).toMatchObject({ tone: "warn", detail: "Add both tokens to connect." });
  });
});

describe("ids and manifest", () => {
  it("checks chat and channel ids", () => {
    expect(isTelegramChatId("-1001234567890")).toBe(true);
    expect(isTelegramChatId("12345")).toBe(true);
    expect(isTelegramChatId("@group")).toBe(false);
    expect(isSlackChannelId("C0123ABCD")).toBe(true);
    expect(isSlackChannelId("#general")).toBe(false);
    expect(isSlackChannelId("D0123ABCD")).toBe(false);
  });

  it("asks for Socket Mode and the scopes the bridge uses", () => {
    expect(SLACK_MANIFEST).toContain("socket_mode_enabled: true");
    for (const scope of [
      "chat:write.customize",
      "commands",
      "files:write",
      "im:history",
      "reactions:write",
    ]) {
      expect(SLACK_MANIFEST).toContain(`- ${scope}`);
    }
  });
});
