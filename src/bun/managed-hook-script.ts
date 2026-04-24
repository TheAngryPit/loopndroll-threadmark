import { MANAGED_HOOK_SCRIPT_CHUNK_1 } from "./managed-hook-script/chunk-1";
import { MANAGED_HOOK_SCRIPT_CHUNK_2 } from "./managed-hook-script/chunk-2";
import { MANAGED_HOOK_SCRIPT_CHUNK_3 } from "./managed-hook-script/chunk-3";
import { DEFAULT_PROMPT } from "./constants";
import { SQLITE_PRAGMA_STATEMENTS } from "./db/client";
import { appMigrations } from "./db/migrations";
import {
  AWAIT_REPLY_POLL_INTERVAL_MS,
  GENERATED_TITLE_MATCH_WINDOW_MS,
  HOOK_DEBUG_LOG_ENV_NAME,
  HOOK_DEBUG_REDACTED_KEYS,
  REDACTED_DEBUG_VALUE,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_NOTIFICATION_FOOTER,
  type LoopndrollPaths,
  MANAGED_HOOK_SCRIPT_MARKER,
} from "./loopndroll-core";
import {
  buildTelegramPromptReceivedText,
  buildTelegramWorkingAckText,
  getTelegramRemotePromptDeliveryMode,
} from "./telegram-control";
import { TELEGRAM_OUTPUT_HOOK_SOURCE } from "./telegram-output";

function getLoopndrollRuntimeState(db: {
  query: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | null };
}) {
  const row = db.query("select runtime_state from settings where id = 1").get();
  return row?.runtime_state === "paused" || row?.runtime_state === "stopped"
    ? row.runtime_state
    : "running";
}

export function normalizeRuntimeStateHelperName(source: string) {
  return source.replace(
    /^function getLoopndrollRuntimeState\d*\(/,
    "function getLoopndrollRuntimeState(",
  );
}

function normalizeManagedHookSchemaReferences(source: string) {
  return source
    .replaceAll(
      'value === "await-reply" ||\n    value === "completion-checks"',
      'value === "await-reply" ||\n    value === "passive" ||\n    value === "completion-checks"',
    )
    .replaceAll(
      "insert into sessions (\n          session_id,",
      "insert into sessions (\n          thread_id,",
    )
    .replaceAll("select\n        session_id,", "select\n        thread_id as session_id,")
    .replaceAll("\n              title = ?,", "\n              thread_name = ?,")
    .replaceAll(
      "\n          title,\n          transcript_path",
      "\n          thread_name,\n          transcript_path",
    )
    .replaceAll(
      "\n        title,\n        transcript_path",
      "\n        thread_name as title,\n        transcript_path",
    )
    .replaceAll(
      "update sessions set title = ? where thread_id = ?",
      "update sessions set thread_name = ? where thread_id = ?",
    )
    .replaceAll(
      "select session_ref, title, archived, cwd from sessions where thread_id = ?",
      "select session_ref, thread_name as title, archived, cwd from sessions where thread_id = ?",
    )
    .replaceAll("where s.session_id = ?", "where s.thread_id = ?")
    .replaceAll("where sn.session_id = ?", "where sn.thread_id = ?")
    .replaceAll("where session_id != ?", "where thread_id != ?")
    .replaceAll("where session_id = ?", "where thread_id = ?")
    .replaceAll(
      "update sessions set title = ? where thread_id = ?",
      "update sessions set thread_name = ? where thread_id = ?",
    )
    .replaceAll(
      "select session_ref, title, archived, cwd from sessions where thread_id = ?",
      "select session_ref, thread_name as title, archived, cwd from sessions where thread_id = ?",
    )
    .replaceAll(
      "insert into session_notifications (session_id, notification_id)",
      "insert into session_notifications (thread_id, notification_id)",
    )
    .replaceAll(
      "on conflict(session_id, notification_id)",
      "on conflict(thread_id, notification_id)",
    )
    .replaceAll(
      "insert into session_runtime (session_id, remaining_turns)",
      "insert into session_runtime (thread_id, remaining_turns)",
    )
    .replaceAll("on conflict(session_id) do update", "on conflict(thread_id) do update")
    .replaceAll(
      "insert into session_awaiting_replies (\n      session_id,",
      "insert into session_awaiting_replies (\n      thread_id,",
    )
    .replaceAll(
      "insert into telegram_delivery_receipts (\n            id,\n            notification_id,\n            session_id,",
      "insert into telegram_delivery_receipts (\n            id,\n            notification_id,\n            thread_id,",
    );
}

export function buildManagedHookScript(paths: LoopndrollPaths) {
  const preamble = `#!/usr/bin/env bun
// ${MANAGED_HOOK_SCRIPT_MARKER}
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const databasePath = ${JSON.stringify(paths.databasePath)};
const logsDirectoryPath = ${JSON.stringify(paths.logsDirectoryPath)};
const hookDebugLogPath = ${JSON.stringify(paths.hookDebugLogPath)};
const defaultPrompt = ${JSON.stringify(DEFAULT_PROMPT)};
const generatedTitleMatchWindowMs = ${String(GENERATED_TITLE_MATCH_WINDOW_MS)};
const awaitReplyPollIntervalMs = ${String(AWAIT_REPLY_POLL_INTERVAL_MS)};
const telegramMaxMessageLength = ${String(TELEGRAM_MAX_MESSAGE_LENGTH)};
const telegramNotificationFooter = ${JSON.stringify(TELEGRAM_NOTIFICATION_FOOTER)};
const hookDebugLogEnvName = ${JSON.stringify(HOOK_DEBUG_LOG_ENV_NAME)};
const redactedDebugValue = ${JSON.stringify(REDACTED_DEBUG_VALUE)};
const hookDebugRedactedKeys = ${JSON.stringify([...HOOK_DEBUG_REDACTED_KEYS])};
const sqlitePragmas = ${JSON.stringify([...SQLITE_PRAGMA_STATEMENTS])};
const appMigrations = ${JSON.stringify(appMigrations)};
`;

  const hookBody = normalizeManagedHookSchemaReferences(
    [
      `${TELEGRAM_OUTPUT_HOOK_SOURCE}\n`,
      `${normalizeRuntimeStateHelperName(getLoopndrollRuntimeState.toString())}\n\n`,
      `${getTelegramRemotePromptDeliveryMode.toString()}\n\n`,
      `${buildTelegramPromptReceivedText.toString()}\n\n`,
      `${buildTelegramWorkingAckText.toString()}\n\n`,
      MANAGED_HOOK_SCRIPT_CHUNK_1,
      MANAGED_HOOK_SCRIPT_CHUNK_2,
      MANAGED_HOOK_SCRIPT_CHUNK_3,
    ].join(""),
  );

  return `${preamble}${hookBody}`;
}
