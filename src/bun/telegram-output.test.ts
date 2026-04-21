import { describe, expect, test } from "bun:test";

import {
  buildTelegramNotificationChunks,
  formatTelegramSessionLabel,
  normalizeTelegramOutputText,
} from "./telegram-output";

describe("normalizeTelegramOutputText", () => {
  test("cleans common markdown noise into chat-friendly text", () => {
    const input = [
      "## Plan",
      "",
      "- [ ] first item",
      "- [x] done item",
      "",
      "**Bold** and [docs](https://example.com/docs)",
      "",
      "> quoted",
    ].join("\n");

    expect(normalizeTelegramOutputText(input)).toBe(
      [
        "Plan",
        "- first item",
        "- [done] done item",
        "",
        "Bold and docs (https://example.com/docs)",
        "quoted",
      ].join("\n"),
    );
  });
});

describe("formatTelegramSessionLabel", () => {
  test("includes project, session ref and title when available", () => {
    expect(
      formatTelegramSessionLabel({
        cwd: "/Users/vitorcepedalopes/Documents/ChiefOfStaff",
        sessionRef: "c12",
        title: "Fix bridge",
      }),
    ).toBe("[ChiefOfStaff] [C12] Fix bridge");
  });
});

describe("buildTelegramNotificationChunks", () => {
  test("keeps footer only on the last chunk and adds numbering", () => {
    const chunks = buildTelegramNotificationChunks({
      cwd: "/Users/vitorcepedalopes/Documents/ChiefOfStaff",
      sessionRef: "C7",
      sessionTitle: "Long report",
      message: Array.from({ length: 140 }, () => "paragraph content").join(" "),
      preset: "await-reply",
      telegramNotificationFooter: "Reply to this message in Telegram to continue this Codex chat.",
      maxLength: 220,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("[ChiefOfStaff] [C7] Long report (1/");
    expect(chunks[1]).toContain("(2/");
    expect(chunks.at(-1)).toContain(
      "Reply to this message in Telegram to continue this Codex chat.",
    );
    expect(chunks[0]).not.toContain(
      "Reply to this message in Telegram to continue this Codex chat.",
    );
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
  });

  test("uses passive-mode footer wording for queued replies", () => {
    const chunks = buildTelegramNotificationChunks({
      cwd: "/Users/vitorcepedalopes/Documents/ChiefOfStaff",
      sessionRef: "C8",
      sessionTitle: "Passive report",
      message: "Short body",
      preset: "passive",
      telegramNotificationFooter: "Reply to this message in Telegram to continue this Codex chat.",
      maxLength: 4096,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(
      "Reply to this message in Telegram to queue the next prompt for this Codex chat.",
    );
    expect(chunks[0]).toContain("Or send /reply C8 your message.");
  });
});
