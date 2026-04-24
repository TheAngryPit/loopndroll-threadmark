import type { Database } from "bun:sqlite";

import type { PassiveWakeInput, PassiveWakeResult } from "./codex-app-server-client";
import { buildTelegramPromptReceivedText, buildTelegramWorkingAckText } from "./telegram-control";

export type TryPassiveSimpleWakeInput = {
  db: Database;
  threadId: string;
  cwd?: string | null;
  sessionRef?: string | null;
  threadName?: string | null;
  promptText: string;
  wake: (input: PassiveWakeInput) => Promise<PassiveWakeResult>;
};

export type TryPassiveSimpleWakeResult =
  | {
      status: "woke";
      ackText: string;
    }
  | {
      status: "queued";
      ackText: string;
    };

export async function tryPassiveSimpleWake(
  input: TryPassiveSimpleWakeInput,
): Promise<TryPassiveSimpleWakeResult> {
  const wakeResult = await input.wake({
    threadId: input.threadId,
    cwd: input.cwd ?? null,
    prompt: input.promptText,
  });

  if (wakeResult.status === "accepted") {
    return {
      status: "woke",
      ackText: buildTelegramWorkingAckText({
        cwd: input.cwd ?? null,
        sessionRef: input.sessionRef ?? null,
        title: input.threadName ?? null,
      }),
    };
  }

  return {
    status: "queued",
    ackText: buildTelegramPromptReceivedText({
      cwd: input.cwd ?? null,
      sessionRef: input.sessionRef ?? null,
      title: input.threadName ?? null,
    }),
  };
}
