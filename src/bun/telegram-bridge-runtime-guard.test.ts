import { describe, expect, test } from "bun:test";

import {
  buildTelegramPromptReceivedText,
  buildTelegramWorkingAckText,
  getTelegramRemotePromptDeliveryMode,
} from "./telegram-control";

describe("telegram bridge await-reply runtime guard", () => {
  test("keeps one-shot delivery for await-reply freeform replies", () => {
    expect(getTelegramRemotePromptDeliveryMode("await-reply")).toBe("once");
  });

  test("keeps the received acknowledgement contract for await-reply /reply fallback", () => {
    const targetSession = {
      cwd: "/Users/example/Documents/ChiefOfStaff",
      sessionRef: "c22",
      title: "Fix bridge",
    };

    expect(buildTelegramPromptReceivedText(targetSession)).toBe(
      ["Reply queued for next Codex stop", "[ChiefOfStaff] [C22]", "Thread: Fix bridge"].join("\n"),
    );
    expect(buildTelegramWorkingAckText(targetSession)).toBe(
      ["Reply delivered to Codex", "[ChiefOfStaff] [C22]", "Thread: Fix bridge"].join("\n"),
    );
  });
});
