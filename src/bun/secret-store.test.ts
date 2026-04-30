import { describe, expect, test } from "bun:test";

import {
  createSlackWebhookUrlKeychainRef,
  createTelegramBotTokenKeychainRef,
  isSlackWebhookUrlKeychainRef,
  isTelegramBotTokenKeychainRef,
} from "./secret-store";

describe("telegram bot token keychain refs", () => {
  test("creates non-secret keychain references for notification-scoped bot tokens", () => {
    const ref = createTelegramBotTokenKeychainRef("notification 1");

    expect(ref).toBe("keychain://loopndroll/telegram-bot-token/notification%201");
    expect(isTelegramBotTokenKeychainRef(ref)).toBe(true);
    expect(ref).not.toContain("opaque-token-value");
  });

  test("does not classify plain Telegram tokens as keychain references", () => {
    expect(isTelegramBotTokenKeychainRef("bot-id:opaque-token-value")).toBe(false);
  });
});

describe("slack webhook URL keychain refs", () => {
  test("creates non-secret keychain references for notification-scoped webhook URLs", () => {
    const ref = createSlackWebhookUrlKeychainRef("notification 1");

    expect(ref).toBe("keychain://loopndroll/slack-webhook-url/notification%201");
    expect(isSlackWebhookUrlKeychainRef(ref)).toBe(true);
    expect(ref).not.toContain("https://hooks.slack.com/services/");
  });

  test("does not classify plain Slack webhook URLs as keychain references", () => {
    expect(isSlackWebhookUrlKeychainRef("https://hooks.slack.com/services/test")).toBe(false);
  });
});
