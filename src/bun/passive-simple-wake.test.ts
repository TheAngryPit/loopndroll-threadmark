import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { tryPassiveSimpleWake } from "./passive-simple-wake";

function createPromptTable(db: Database) {
  db.exec(
    "create table session_remote_prompts (thread_id text not null, source text not null, delivery_mode text not null, prompt_text text not null, telegram_chat_id text, telegram_message_id integer, created_at text not null, primary key(thread_id, delivery_mode));",
  );
}

function seedQueuedPrompt(db: Database, threadId: string, promptText: string) {
  db.query(
    `insert into session_remote_prompts (
      thread_id,
      source,
      delivery_mode,
      prompt_text,
      telegram_chat_id,
      telegram_message_id,
      created_at
    ) values (?, 'telegram', 'once', ?, '1', 1, ?)`,
  ).run(threadId, promptText, new Date().toISOString());
}

describe("tryPassiveSimpleWake", () => {
  test("keeps the queued prompt and returns Working until completion cleanup runs", async () => {
    const db = new Database(":memory:");
    createPromptTable(db);
    seedQueuedPrompt(db, "thr_123", "Continue with the Telegram reply.");

    const result = await tryPassiveSimpleWake({
      db,
      threadId: "thr_123",
      cwd: "/tmp/project",
      sessionRef: "C12",
      threadName: "Fix passive wake",
      promptText: "Continue with the Telegram reply.",
      wake: async () => ({ status: "accepted", threadId: "thr_123", turnId: "turn_1" }),
    });

    const row = db
      .query(
        "select prompt_text from session_remote_prompts where thread_id = ? and delivery_mode = 'once'",
      )
      .get("thr_123");

    expect(result).toEqual({
      status: "woke",
      ackText: "Working on [project] [C12] Fix passive wake.",
    });
    expect(row).toEqual({
      prompt_text: "Continue with the Telegram reply.",
    });
  });

  test("keeps the queued prompt when wake is unavailable", async () => {
    const db = new Database(":memory:");
    createPromptTable(db);
    seedQueuedPrompt(db, "thr_123", "Continue with the Telegram reply.");

    const result = await tryPassiveSimpleWake({
      db,
      threadId: "thr_123",
      cwd: "/tmp/project",
      sessionRef: "C12",
      threadName: "Fix passive wake",
      promptText: "Continue with the Telegram reply.",
      wake: async () => ({ status: "unavailable", reason: "initialize-failed" }),
    });

    const row = db
      .query(
        "select prompt_text from session_remote_prompts where thread_id = ? and delivery_mode = 'once'",
      )
      .get("thr_123");

    expect(result).toEqual({
      status: "queued",
      ackText: "Received for [project] [C12] Fix passive wake.",
    });
    expect(row).toEqual({
      prompt_text: "Continue with the Telegram reply.",
    });
  });
});
