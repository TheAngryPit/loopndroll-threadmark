import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { hookLifecycleMigrations } from "./hook-lifecycle-migrations";

function applyParkPassiveMigration(db: Database) {
  const migration = hookLifecycleMigrations.find(
    (candidate) => candidate.name === "park_passive_v1",
  );
  if (!migration) {
    throw new Error("park_passive_v1 migration is missing");
  }

  for (const statement of migration.statements) {
    db.exec(statement);
  }
}

function createPassiveMigrationSchema(db: Database) {
  db.exec(`
    create table settings (
      id integer primary key,
      global_preset text
    );

    create table sessions (
      thread_id text primary key,
      preset text,
      preset_overridden integer not null default 0,
      active_since text
    );

    create table session_remote_prompts (
      thread_id text not null,
      delivery_mode text not null,
      prompt_text text not null,
      primary key(thread_id, delivery_mode)
    );
  `);
}

describe("hook lifecycle migrations", () => {
  test("parks explicit and inherited passive state without leaving stale Telegram prompts", () => {
    const db = new Database(":memory:");
    createPassiveMigrationSchema(db);
    db.query("insert into settings (id, global_preset) values (1, 'passive')").run();
    db.query(
      `insert into sessions (thread_id, preset, preset_overridden, active_since) values
        ('explicit_passive', 'passive', 1, '2026-04-24T10:00:00.000Z'),
        ('inherited_passive', null, 0, '2026-04-24T10:00:00.000Z'),
        ('explicit_await', 'await-reply', 1, '2026-04-24T10:00:00.000Z')`,
    ).run();
    db.query(
      `insert into session_remote_prompts (thread_id, delivery_mode, prompt_text) values
        ('explicit_passive', 'once', 'stale explicit passive prompt'),
        ('inherited_passive', 'once', 'stale inherited passive prompt'),
        ('explicit_await', 'once', 'valid await prompt')`,
    ).run();

    applyParkPassiveMigration(db);

    expect(db.query("select global_preset from settings where id = 1").get()).toEqual({
      global_preset: null,
    });
    expect(
      db
        .query(
          "select preset, preset_overridden, active_since from sessions where thread_id = 'explicit_passive'",
        )
        .get(),
    ).toEqual({
      preset: null,
      preset_overridden: 1,
      active_since: null,
    });
    expect(
      db
        .query(
          "select preset, preset_overridden, active_since from sessions where thread_id = 'inherited_passive'",
        )
        .get(),
    ).toEqual({
      preset: null,
      preset_overridden: 0,
      active_since: null,
    });
    expect(
      db
        .query("select thread_id, prompt_text from session_remote_prompts order by thread_id")
        .all(),
    ).toEqual([{ thread_id: "explicit_await", prompt_text: "valid await prompt" }]);
  });
});
