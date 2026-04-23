import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  findLatestAwaitingTelegramSessionId,
  findTelegramSessionByRef,
  listRegisteredTelegramSessions,
} from "./telegram-bridge-session-store";

function createTelegramBridgeSchema(db: Database) {
  db.exec(`
    create table settings (
      id integer primary key,
      global_preset text
    );
    insert into settings (id, global_preset) values (1, null);

    create table notifications (
      id text primary key,
      channel text not null,
      bot_token text,
      chat_id text
    );

    create table sessions (
      thread_id text primary key,
      session_ref text not null,
      cwd text,
      thread_name text,
      transcript_path text,
      last_assistant_message text,
      first_seen_at text not null,
      last_seen_at text not null,
      active_since text,
      preset text,
      preset_overridden integer not null default 0,
      archived integer not null default 0
    );

    create table session_notifications (
      thread_id text not null,
      notification_id text not null
    );

    create table session_awaiting_replies (
      thread_id text not null,
      bot_token text not null,
      chat_id text not null,
      started_at text not null
    );
  `);
}

describe("telegram bridge session store", () => {
  test("lists registered sessions from the current thread_id/thread_name schema", () => {
    const db = new Database(":memory:");
    createTelegramBridgeSchema(db);

    db.query(
      "insert into notifications (id, channel, bot_token, chat_id) values ('n1', 'telegram', 'bot', 'chat')",
    ).run();
    db.query(
      `insert into sessions (
        thread_id,
        session_ref,
        cwd,
        thread_name,
        transcript_path,
        last_assistant_message,
        first_seen_at,
        last_seen_at,
        active_since,
        preset,
        preset_overridden,
        archived
      ) values (?, 'C22', '/tmp/project', 'Fix passive wake', null, null, ?, ?, null, 'passive', 0, 0)`,
    ).run("thr_123", "2026-04-23T10:00:00.000Z", "2026-04-23T10:00:00.000Z");
    db.query(
      "insert into session_notifications (thread_id, notification_id) values ('thr_123', 'n1')",
    ).run();

    const sessions = listRegisteredTelegramSessions(db, "bot", "chat");

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "thr_123",
      sessionRef: "C22",
      cwd: "/tmp/project",
      title: "Fix passive wake",
      effectivePreset: "passive",
    });

    expect(findTelegramSessionByRef(db, "bot", "chat", "c22")).toEqual({
      sessionId: "thr_123",
      sessionRef: "C22",
      cwd: "/tmp/project",
      title: "Fix passive wake",
    });
  });

  test("finds the latest awaiting reply using the current thread_id schema", () => {
    const db = new Database(":memory:");
    createTelegramBridgeSchema(db);

    db.query(
      `insert into sessions (
        thread_id,
        session_ref,
        cwd,
        thread_name,
        transcript_path,
        last_assistant_message,
        first_seen_at,
        last_seen_at,
        active_since,
        preset,
        preset_overridden,
        archived
      ) values
        ('thr_old', 'C11', '/tmp/project', 'Old', null, null, '2026-04-23T09:00:00.000Z', '2026-04-23T09:00:00.000Z', null, 'await-reply', 0, 0),
        ('thr_new', 'C12', '/tmp/project', 'New', null, null, '2026-04-23T10:00:00.000Z', '2026-04-23T10:00:00.000Z', null, 'await-reply', 0, 0)`,
    ).run();
    db.query(
      `insert into session_awaiting_replies (thread_id, bot_token, chat_id, started_at) values
        ('thr_old', 'bot', 'chat', '2026-04-23T09:00:00.000Z'),
        ('thr_new', 'bot', 'chat', '2026-04-23T10:00:00.000Z')`,
    ).run();

    expect(findLatestAwaitingTelegramSessionId(db, "bot", "chat")).toBe("thr_new");
  });
});
