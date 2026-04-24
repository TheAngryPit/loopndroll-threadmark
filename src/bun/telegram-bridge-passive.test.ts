import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  handlePassiveReplyCommand,
  handlePassiveReplyDelivery,
} from "./telegram-bridge-session-store";

function createPromptTable(db: Database) {
  db.exec(
    "create table session_remote_prompts (thread_id text not null, source text not null, delivery_mode text not null, prompt_text text not null, telegram_chat_id text, telegram_message_id integer, created_at text not null, primary key(thread_id, delivery_mode));",
  );
}

describe("handlePassiveReplyCommand", () => {
  test("queues first, preserves the one-shot prompt, and returns Working when passive wake is active", async () => {
    const db = new Database(":memory:");
    createPromptTable(db);
    let promptWasQueuedBeforeWake = false;

    const result = await handlePassiveReplyCommand({
      db,
      targetSession: {
        sessionId: "thr_123",
        sessionRef: "C22",
        cwd: "/tmp/project",
        title: "Fix passive wake",
      },
      promptText: "Continue with the Telegram reply.",
      message: {
        chat: { id: "1" },
        message_id: 1,
      },
      wake: async () => {
        const queuedRow = db
          .query(
            "select prompt_text from session_remote_prompts where thread_id = ? and delivery_mode = 'once'",
          )
          .get("thr_123") as { prompt_text?: string } | null;
        promptWasQueuedBeforeWake = queuedRow?.prompt_text === "Continue with the Telegram reply.";

        return {
          status: "accepted",
          threadId: "thr_123",
          turnId: "turn_1",
        };
      },
    });

    const rowAfterWake = db
      .query(
        "select prompt_text from session_remote_prompts where thread_id = ? and delivery_mode = 'once'",
      )
      .get("thr_123");

    expect(promptWasQueuedBeforeWake).toBe(true);
    expect(result).toEqual({
      ackText: "Working on [project] [C22] Fix passive wake.",
    });
    expect(rowAfterWake).toEqual({
      prompt_text: "Continue with the Telegram reply.",
    });
  });

  test("defaults to queue-only until live Codex app UI sync is available", async () => {
    const db = new Database(":memory:");
    createPromptTable(db);

    const result = await handlePassiveReplyCommand({
      db,
      targetSession: {
        sessionId: "thr_123",
        sessionRef: "C22",
        cwd: "/tmp/project",
        title: "Fix passive wake",
      },
      promptText: "Continue with the Telegram reply.",
      message: {
        chat: { id: "1" },
        message_id: 1,
      },
    });

    expect(result).toEqual({
      ackText: "Received for [project] [C22] Fix passive wake.",
    });
    expect(
      db
        .query(
          "select prompt_text from session_remote_prompts where thread_id = ? and delivery_mode = 'once'",
        )
        .get("thr_123"),
    ).toEqual({
      prompt_text: "Continue with the Telegram reply.",
    });
  });
});

describe("handlePassiveReplyDelivery", () => {
  test("keeps the queued prompt and returns Received when passive reply-to wake is unavailable", async () => {
    const db = new Database(":memory:");
    createPromptTable(db);
    let promptWasQueuedBeforeWake = false;

    const result = await handlePassiveReplyDelivery({
      db,
      targetSession: {
        sessionId: "thr_123",
        sessionRef: "C22",
        cwd: "/tmp/project",
        title: "Fix passive wake",
      },
      promptText: "Continue with the Telegram reply.",
      message: {
        chat: { id: "1" },
        message_id: 2,
        reply_to_message: {
          message_id: 1,
        },
      },
      wake: async () => {
        const queuedRow = db
          .query(
            "select prompt_text from session_remote_prompts where thread_id = ? and delivery_mode = 'once'",
          )
          .get("thr_123") as { prompt_text?: string } | null;
        promptWasQueuedBeforeWake = queuedRow?.prompt_text === "Continue with the Telegram reply.";

        return {
          status: "unavailable",
          reason: "initialize-failed",
        };
      },
    });

    const rowAfterWake = db
      .query(
        "select prompt_text from session_remote_prompts where thread_id = ? and delivery_mode = 'once'",
      )
      .get("thr_123");

    expect(promptWasQueuedBeforeWake).toBe(true);
    expect(result).toEqual({
      ackText: "Received for [project] [C22] Fix passive wake.",
    });
    expect(rowAfterWake).toEqual({
      prompt_text: "Continue with the Telegram reply.",
    });
  });
});
