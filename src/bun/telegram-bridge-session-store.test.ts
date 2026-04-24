import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  disableAllTelegramSessionsViaFailsafe,
  disableTelegramSessionViaFailsafe,
  findLatestAwaitingTelegramSessionId,
  findLatestPassiveTelegramReceiptSessionIdBeforeMessage,
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

    create table session_runtime (
      thread_id text primary key,
      started_at text not null
    );

    create table session_remote_prompts (
      thread_id text not null,
      source text not null,
      delivery_mode text not null,
      prompt_text text not null,
      created_at text not null,
      primary key(thread_id, delivery_mode)
    );

    create table telegram_delivery_receipts (
      id text primary key,
      notification_id text,
      thread_id text not null,
      bot_token text not null,
      chat_id text not null,
      telegram_message_id integer not null,
      created_at text not null
    );
  `);
}

function insertFailsafeFixtureSessions(db: Database) {
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
      ('thr_target', 'C12', '/tmp/project', 'Target', null, null, '2026-04-23T10:00:00.000Z', '2026-04-23T10:00:00.000Z', '2026-04-23T10:00:00.000Z', 'passive', 1, 0),
      ('thr_other', 'C13', '/tmp/project', 'Other', null, null, '2026-04-23T11:00:00.000Z', '2026-04-23T11:00:00.000Z', '2026-04-23T11:00:00.000Z', 'passive', 1, 0)`,
  ).run();
}

function insertFailsafeFixtureRemoteState(db: Database) {
  db.query(
    `insert into session_awaiting_replies (thread_id, bot_token, chat_id, started_at) values
      ('thr_target', 'bot', 'chat', '2026-04-23T10:01:00.000Z'),
      ('thr_other', 'bot', 'chat', '2026-04-23T11:01:00.000Z')`,
  ).run();
  db.query(
    `insert into session_runtime (thread_id, started_at) values
      ('thr_target', '2026-04-23T10:02:00.000Z'),
      ('thr_other', '2026-04-23T11:02:00.000Z')`,
  ).run();
  db.query(
    `insert into session_remote_prompts (thread_id, source, delivery_mode, prompt_text, created_at) values
      ('thr_target', 'telegram', 'once', 'target prompt', '2026-04-23T10:03:00.000Z'),
      ('thr_other', 'telegram', 'once', 'other prompt', '2026-04-23T11:03:00.000Z')`,
  ).run();
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

describe("telegram bridge failsafe", () => {
  test("disables one session and clears only that session's pending remote state", () => {
    const db = new Database(":memory:");
    createTelegramBridgeSchema(db);
    insertFailsafeFixtureSessions(db);
    insertFailsafeFixtureRemoteState(db);

    disableTelegramSessionViaFailsafe(db, "thr_target");

    expect(
      db
        .query("select preset, preset_overridden, active_since from sessions where thread_id = ?")
        .get("thr_target"),
    ).toEqual({
      preset: null,
      preset_overridden: 1,
      active_since: null,
    });
    expect(db.query("select count(*) as count from session_runtime").get()).toEqual({ count: 1 });
    expect(db.query("select count(*) as count from session_awaiting_replies").get()).toEqual({
      count: 1,
    });
    expect(db.query("select count(*) as count from session_remote_prompts").get()).toEqual({
      count: 1,
    });
    expect(
      db.query("select prompt_text from session_remote_prompts where thread_id = ?").get(
        "thr_other",
      ),
    ).toEqual({ prompt_text: "other prompt" });
  });

  test("disables global and every active session while clearing pending remote state", () => {
    const db = new Database(":memory:");
    createTelegramBridgeSchema(db);
    db.query("update settings set global_preset = 'passive' where id = 1").run();
    insertFailsafeFixtureSessions(db);
    insertFailsafeFixtureRemoteState(db);

    disableAllTelegramSessionsViaFailsafe(db);

    expect(db.query("select global_preset from settings where id = 1").get()).toEqual({
      global_preset: null,
    });
    expect(
      db
        .query(
          "select count(*) as count from sessions where preset is null and preset_overridden = 1 and active_since is null",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(db.query("select count(*) as count from session_runtime").get()).toEqual({ count: 0 });
    expect(db.query("select count(*) as count from session_awaiting_replies").get()).toEqual({
      count: 0,
    });
    expect(db.query("select count(*) as count from session_remote_prompts").get()).toEqual({
      count: 0,
    });
  });
});

describe("telegram bridge loose-message targeting", () => {
  test("finds the latest passive notification before a loose Telegram message", () => {
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
        ('thr_old', 'C11', '/tmp/project', 'Old passive', null, null, '2026-04-23T09:00:00.000Z', '2026-04-23T09:00:00.000Z', null, 'passive', 1, 0),
        ('thr_off', 'C12', '/tmp/project', 'Off', null, null, '2026-04-23T10:00:00.000Z', '2026-04-23T10:00:00.000Z', null, null, 1, 0),
        ('thr_new', 'C13', '/tmp/project', 'New passive', null, null, '2026-04-23T11:00:00.000Z', '2026-04-23T11:00:00.000Z', null, 'passive', 1, 0),
        ('thr_future', 'C14', '/tmp/project', 'Future passive', null, null, '2026-04-23T12:00:00.000Z', '2026-04-23T12:00:00.000Z', null, 'passive', 1, 0)`,
    ).run();
    db.query(
      `insert into telegram_delivery_receipts (
        id,
        notification_id,
        thread_id,
        bot_token,
        chat_id,
        telegram_message_id,
        created_at
      ) values
        ('r_old', null, 'thr_old', 'bot', 'chat', 10, '2026-04-23T09:01:00.000Z'),
        ('r_off', null, 'thr_off', 'bot', 'chat', 11, '2026-04-23T10:01:00.000Z'),
        ('r_new', null, 'thr_new', 'bot', 'chat', 12, '2026-04-23T11:01:00.000Z'),
        ('r_future', null, 'thr_future', 'bot', 'chat', 14, '2026-04-23T12:01:00.000Z')`,
    ).run();

    expect(findLatestPassiveTelegramReceiptSessionIdBeforeMessage(db, "bot", "chat", 13)).toBe(
      "thr_new",
    );
  });

  test("uses inherited global passive mode for loose Telegram message targeting", () => {
    const db = new Database(":memory:");
    createTelegramBridgeSchema(db);
    db.query("update settings set global_preset = 'passive' where id = 1").run();

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
        ('thr_inherited', 'C12', '/tmp/project', 'Inherited passive', null, null, '2026-04-23T10:00:00.000Z', '2026-04-23T10:00:00.000Z', null, null, 0, 0),
        ('thr_opted_out', 'C13', '/tmp/project', 'Opted out', null, null, '2026-04-23T11:00:00.000Z', '2026-04-23T11:00:00.000Z', null, null, 1, 0)`,
    ).run();
    db.query(
      `insert into telegram_delivery_receipts (
        id,
        notification_id,
        thread_id,
        bot_token,
        chat_id,
        telegram_message_id,
        created_at
      ) values
        ('r_inherited', null, 'thr_inherited', 'bot', 'chat', 11, '2026-04-23T10:01:00.000Z'),
        ('r_opted_out', null, 'thr_opted_out', 'bot', 'chat', 12, '2026-04-23T11:01:00.000Z')`,
    ).run();

    expect(findLatestPassiveTelegramReceiptSessionIdBeforeMessage(db, "bot", "chat", 13)).toBe(
      "thr_inherited",
    );
  });
});

describe("telegram bridge passive-only loose-message targeting", () => {
  test("does not target non-passive receipts for loose Telegram messages", () => {
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
        ('thr_await', 'C12', '/tmp/project', 'Await reply', null, null, '2026-04-23T10:00:00.000Z', '2026-04-23T10:00:00.000Z', null, 'await-reply', 1, 0),
        ('thr_infinite', 'C13', '/tmp/project', 'Infinite', null, null, '2026-04-23T11:00:00.000Z', '2026-04-23T11:00:00.000Z', null, 'infinite', 1, 0)`,
    ).run();
    db.query(
      `insert into telegram_delivery_receipts (
        id,
        notification_id,
        thread_id,
        bot_token,
        chat_id,
        telegram_message_id,
        created_at
      ) values
        ('r_await', null, 'thr_await', 'bot', 'chat', 11, '2026-04-23T10:01:00.000Z'),
        ('r_infinite', null, 'thr_infinite', 'bot', 'chat', 12, '2026-04-23T11:01:00.000Z')`,
    ).run();

    expect(
      findLatestPassiveTelegramReceiptSessionIdBeforeMessage(db, "bot", "chat", 13),
    ).toBeNull();
  });
});
