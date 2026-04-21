import { describe, expect, test } from "bun:test";

import {
  buildTelegramPromptReceivedText,
  buildTelegramWorkingAckText,
  getTelegramRemotePromptDeliveryMode,
} from "./telegram-control";

describe("getTelegramRemotePromptDeliveryMode", () => {
  test("uses one-shot delivery for await-reply and passive", () => {
    expect(getTelegramRemotePromptDeliveryMode("await-reply")).toBe("once");
    expect(getTelegramRemotePromptDeliveryMode("passive")).toBe("once");
  });

  test("keeps persistent delivery for continuous auto-run modes", () => {
    expect(getTelegramRemotePromptDeliveryMode("infinite")).toBe("persistent");
    expect(getTelegramRemotePromptDeliveryMode("completion-checks")).toBe("persistent");
  });
});

describe("Telegram ack text", () => {
  test("formats received acknowledgements with project-aware labels", () => {
    expect(
      buildTelegramPromptReceivedText({
        cwd: "/Users/vitorcepedalopes/Documents/ChiefOfStaff",
        sessionRef: "c22",
        title: "Fix bridge",
      }),
    ).toBe("Received for [ChiefOfStaff] [C22] Fix bridge.");
  });

  test("formats working acknowledgements with project-aware labels", () => {
    expect(
      buildTelegramWorkingAckText({
        cwd: "/Users/vitorcepedalopes/Documents/ChiefOfStaff",
        sessionRef: "c22",
        title: "Fix bridge",
      }),
    ).toBe("Working on [ChiefOfStaff] [C22] Fix bridge.");
  });
});
