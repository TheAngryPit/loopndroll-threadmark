import { type Database } from "bun:sqlite";
import type { LoopPreset } from "../shared/app-rpc";
import { getLoopndrollDatabase } from "./db/client";
import {
  TELEGRAM_BRIDGE_POLL_INTERVAL_MS,
  type LoopndrollPaths,
  appendHookDebugLog,
  normalizeLoopndrollRuntimeState,
  nowIsoString,
  optOutExistingInactiveSessionsFromGlobalPreset,
  resolveSessionPresetState,
  getLoopndrollPaths,
} from "./loopndroll-core";
import {
  buildTelegramHelpText,
  buildTelegramSessionListText,
  buildTelegramStatusText,
  getModeCommandLabel,
  getTelegramStatusSnapshot,
} from "./telegram-bridge-text";
import {
  buildTelegramPromptReceivedText,
  getTelegramRemotePromptDeliveryMode,
} from "./telegram-control";
import {
  createTelegramBridgeUpdateContext,
  formatTelegramTargetSessionLabel,
  prepareTelegramBridgeUpdate,
  type TelegramBridgeUpdateContext,
} from "./telegram-bridge-context";
import {
  clearRemotePromptStateForGlobalPreset,
  clearRemotePromptStateForPreset,
  findLatestAwaitingTelegramSessionId,
  findTelegramReplySessionId,
  findTelegramSessionById,
  findTelegramSessionByRef,
  getEffectivePresetForSession,
  handlePassiveReplyCommand,
  handlePassiveReplyDelivery,
  listRegisteredTelegramSessions,
  type TelegramBridgeTargetSession,
  upsertSessionRemotePrompt,
} from "./telegram-bridge-session-store";
import {
  fetchTelegramUpdates,
  sendTelegramBridgeMessage,
  type TelegramUpdate,
} from "./telegram-utils";

function getTelegramBridgeBotTokens(db: Database) {
  const rows = db
    .query(
      `select distinct bot_token
      from notifications
      where channel = 'telegram'
        and bot_token is not null
        and trim(bot_token) != ''`,
    )
    .all() as Array<{
    bot_token: string;
  }>;

  return rows.map((row) => row.bot_token?.trim() ?? "").filter((botToken) => botToken.length > 0);
}

function getTelegramUpdateCursor(db: Database, botToken: string) {
  const row = db
    .query("select last_update_id from telegram_update_cursors where bot_token = ?")
    .get(botToken) as { last_update_id?: number } | null;

  return typeof row?.last_update_id === "number" ? row.last_update_id : null;
}

function setTelegramUpdateCursor(db: Database, botToken: string, lastUpdateId: number) {
  const updatedAt = nowIsoString();
  db.query(
    `insert into telegram_update_cursors (bot_token, last_update_id, updated_at)
      values (?, ?, ?)
      on conflict(bot_token) do update set
        last_update_id = excluded.last_update_id,
        updated_at = excluded.updated_at`,
  ).run(botToken, lastUpdateId, updatedAt);
}

function isAuthorizedTelegramBridgeChat(db: Database, botToken: string, chatId: string) {
  const row = db
    .query(
      `select 1
      from notifications
      where channel = 'telegram'
        and bot_token = ?
        and chat_id = ?
      limit 1`,
    )
    .get(botToken, chatId);

  return Boolean(row);
}

function getTelegramCommandName(text: string) {
  const token = text.trim().split(/\s+/, 1)[0] ?? "";
  const match = /^\/([a-z0-9_]+)(?:@\w+)?$/i.exec(token);
  return match?.[1]?.toLowerCase() ?? null;
}

function getLoopndrollRuntimeState(db: Database) {
  const row = db.query("select runtime_state from settings where id = 1").get() as {
    runtime_state?: unknown;
  } | null;

  return normalizeLoopndrollRuntimeState(row?.runtime_state);
}

function parseReplyCommand(text: string) {
  const match = /^\/reply(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i.exec(text.trim());
  if (!match) {
    return null;
  }

  const sessionRef = match[1]?.trim().toUpperCase() ?? "";
  const promptText = match[2]?.trim() ?? "";
  if (sessionRef.length === 0 || promptText.length === 0) {
    return null;
  }

  return { sessionRef, promptText };
}

function parseModeCommand(text: string) {
  const match = /^\/mode(?:@\w+)?\s+(\S+)\s+(\S+)$/i.exec(text.trim());
  if (!match) {
    return null;
  }

  const rawTarget = match[1]?.trim() ?? "";
  const rawMode = match[2]?.trim().toLowerCase() ?? "";
  if (rawTarget.length === 0 || rawMode.length === 0) {
    return null;
  }

  const preset: LoopPreset | null =
    rawMode === "off"
      ? null
      : rawMode === "infinite"
        ? "infinite"
        : rawMode === "await"
          ? "await-reply"
          : rawMode === "passive"
            ? "passive"
            : rawMode === "checks"
              ? "completion-checks"
              : null;
  if (rawMode !== "off" && preset === null) {
    return null;
  }

  return {
    target: rawTarget.toLowerCase() === "global" ? "global" : rawTarget.toUpperCase(),
    preset,
    rawMode,
  };
}

function updateSessionPresetFromBridge(db: Database, sessionId: string, preset: LoopPreset | null) {
  const existingSession = db
    .query(
      "select preset, preset_overridden, active_since, archived from sessions where thread_id = ? limit 1",
    )
    .get(sessionId) as {
    preset?: unknown;
    preset_overridden?: unknown;
    active_since?: string | null;
    archived?: unknown;
  } | null;
  if (!existingSession) {
    return false;
  }
  if (existingSession.archived) {
    return false;
  }

  const previousPreset = resolveSessionPresetState(
    existingSession.preset,
    existingSession.preset_overridden,
    null,
  ).effectivePreset;
  const nextActiveSince =
    previousPreset === null && preset !== null
      ? nowIsoString()
      : previousPreset !== null && preset === null
        ? null
        : (existingSession.active_since ?? null);
  const isRestartingFromOff = previousPreset === null && preset !== null;

  const applyUpdate = db.transaction(() => {
    db.query(
      `update sessions
       set preset = ?,
           preset_overridden = 1,
           active_since = ?
       where thread_id = ?`,
    ).run(preset, nextActiveSince, sessionId);

    db.query("delete from session_runtime where thread_id = ?").run(sessionId);

    if (preset !== "await-reply") {
      db.query("delete from session_awaiting_replies where thread_id = ?").run(sessionId);
    }

    if (isRestartingFromOff) {
      clearRemotePromptStateForPreset(db, sessionId, null);
      return;
    }

    if (preset === null) {
      clearRemotePromptStateForPreset(db, sessionId, null);
      return;
    }

    clearRemotePromptStateForPreset(db, sessionId, preset);
  });

  applyUpdate();

  return true;
}

function updateGlobalPresetFromBridge(db: Database, preset: LoopPreset | null) {
  const applyUpdate = db.transaction(() => {
    if (preset !== null) {
      optOutExistingInactiveSessionsFromGlobalPreset(db);
    }

    db.query("update settings set global_preset = ? where id = 1").run(preset);

    if (preset === null) {
      db.run(
        `update sessions
         set active_since = null
         where archived = 0
           and preset_overridden = 0`,
      );
    }

    db.query("delete from session_runtime").run();

    clearRemotePromptStateForGlobalPreset(db, preset);
  });

  applyUpdate();
}

async function handleListCommand(context: TelegramBridgeUpdateContext) {
  const sessionsForChat = listRegisteredTelegramSessions(
    context.db,
    context.botToken,
    context.chatId,
  );
  await sendTelegramBridgeMessage(
    context.botToken,
    context.chatId,
    buildTelegramSessionListText(sessionsForChat),
  );
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "list-sessions",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
    sessionCount: sessionsForChat.length,
  });
}

async function handleStatusCommand(context: TelegramBridgeUpdateContext) {
  const sessionsForChat = listRegisteredTelegramSessions(
    context.db,
    context.botToken,
    context.chatId,
  );
  const settingsSnapshot = getTelegramStatusSnapshot(context.db);
  await sendTelegramBridgeMessage(
    context.botToken,
    context.chatId,
    buildTelegramStatusText(settingsSnapshot, sessionsForChat),
  );
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "status",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
    sessionCount: sessionsForChat.length,
    scope: settingsSnapshot.scope,
    globalPreset: settingsSnapshot.globalPreset,
  });
}

async function handleHelpCommand(context: TelegramBridgeUpdateContext) {
  await sendTelegramBridgeMessage(context.botToken, context.chatId, buildTelegramHelpText());
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "help",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
  });
}

async function sendReplyUsage(context: TelegramBridgeUpdateContext) {
  await sendTelegramBridgeMessage(
    context.botToken,
    context.chatId,
    "Usage: /reply C12 your message",
  );
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "reply-usage",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
  });
}

async function sendReplyMiss(
  context: TelegramBridgeUpdateContext,
  parsedReply: { sessionRef: string },
) {
  await sendTelegramBridgeMessage(
    context.botToken,
    context.chatId,
    `Chat ${parsedReply.sessionRef} is not registered to this Telegram destination.`,
  );
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "reply-miss",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
    sessionRef: parsedReply.sessionRef,
  });
}

async function sendReplyNoMode(
  context: TelegramBridgeUpdateContext,
  targetSession: TelegramBridgeTargetSession,
) {
  await sendTelegramBridgeMessage(
    context.botToken,
    context.chatId,
    `[${targetSession.sessionRef}] has no active mode. Use /mode ${targetSession.sessionRef} infinite|await|passive first.`,
  );
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "reply-no-mode",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
    sessionId: targetSession.sessionId,
    sessionRef: targetSession.sessionRef,
  });
}

async function handleReplyCommand(context: TelegramBridgeUpdateContext) {
  const parsedReply = parseReplyCommand(context.trimmedText);
  if (!parsedReply) {
    await sendReplyUsage(context);
    return;
  }

  const targetSession = findTelegramSessionByRef(
    context.db,
    context.botToken,
    context.chatId,
    parsedReply.sessionRef,
  );
  if (!targetSession) {
    await sendReplyMiss(context, parsedReply);
    return;
  }

  const effectivePreset = getEffectivePresetForSession(context.db, targetSession.sessionId);
  if (!effectivePreset) {
    await sendReplyNoMode(context, targetSession);
    return;
  }

  if (effectivePreset === "passive") {
    const passiveResult = await handlePassiveReplyCommand({
      db: context.db,
      targetSession,
      promptText: parsedReply.promptText,
      message: context.message,
    });
    await sendTelegramBridgeMessage(context.botToken, context.chatId, passiveResult.ackText);
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "queue-command-prompt",
      botToken: context.botToken,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      sessionId: targetSession.sessionId,
      sessionRef: targetSession.sessionRef,
      preset: effectivePreset,
    });
    return;
  }

  upsertSessionRemotePrompt(
    context.db,
    targetSession.sessionId,
    parsedReply.promptText,
    getTelegramRemotePromptDeliveryMode(effectivePreset),
    context.message,
  );
  await sendTelegramBridgeMessage(
    context.botToken,
    context.chatId,
    buildTelegramPromptReceivedText(targetSession),
  );
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "queue-command-prompt",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
    sessionId: targetSession.sessionId,
    sessionRef: targetSession.sessionRef,
  });
}

async function handleModeCommand(context: TelegramBridgeUpdateContext) {
  const parsedMode = parseModeCommand(context.trimmedText);
  if (!parsedMode) {
    await sendTelegramBridgeMessage(
      context.botToken,
      context.chatId,
      "Usage: /mode global infinite|await|passive|off or /mode C22 infinite|await|passive|off",
    );
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "mode-usage",
      botToken: context.botToken,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
    });
    return;
  }

  if (parsedMode.target === "global") {
    updateGlobalPresetFromBridge(context.db, parsedMode.preset);
    await sendTelegramBridgeMessage(
      context.botToken,
      context.chatId,
      `Global mode set to ${getModeCommandLabel(parsedMode.preset)}.`,
    );
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "mode-global",
      botToken: context.botToken,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      preset: parsedMode.preset,
    });
    return;
  }

  const targetSession = findTelegramSessionByRef(
    context.db,
    context.botToken,
    context.chatId,
    parsedMode.target,
  );
  if (!targetSession) {
    await sendTelegramBridgeMessage(
      context.botToken,
      context.chatId,
      `Chat ${parsedMode.target} is not registered to this Telegram destination.`,
    );
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "mode-miss",
      botToken: context.botToken,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      sessionRef: parsedMode.target,
    });
    return;
  }

  updateSessionPresetFromBridge(context.db, targetSession.sessionId, parsedMode.preset);
  await sendTelegramBridgeMessage(
    context.botToken,
    context.chatId,
    `${formatTelegramTargetSessionLabel(targetSession)} set to ${getModeCommandLabel(parsedMode.preset)}.`,
  );
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: "mode-session",
    botToken: context.botToken,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
    sessionId: targetSession.sessionId,
    sessionRef: targetSession.sessionRef,
    preset: parsedMode.preset,
  });
}

async function handleTelegramBridgeCommand(
  context: TelegramBridgeUpdateContext,
  commandName: string,
) {
  switch (commandName) {
    case "list": {
      await handleListCommand(context);
      return true;
    }
    case "status": {
      await handleStatusCommand(context);
      return true;
    }
    case "help": {
      await handleHelpCommand(context);
      return true;
    }
    case "reply": {
      await handleReplyCommand(context);
      return true;
    }
    case "mode": {
      await handleModeCommand(context);
      return true;
    }
    default: {
      return false;
    }
  }
}

async function handleFreeformTelegramMessage(context: TelegramBridgeUpdateContext) {
  const replyToMessageId = context.message.reply_to_message?.message_id;
  const sessionId =
    typeof replyToMessageId === "number"
      ? findTelegramReplySessionId(context.db, context.botToken, context.chatId, replyToMessageId)
      : findLatestAwaitingTelegramSessionId(context.db, context.botToken, context.chatId);
  if (!sessionId) {
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "ignored-message",
      reason: typeof replyToMessageId === "number" ? "unknown-reply-target" : "no-waiting-session",
      botToken: context.botToken,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      replyToMessageId: typeof replyToMessageId === "number" ? replyToMessageId : null,
    });
    return;
  }

  const effectivePreset = getEffectivePresetForSession(context.db, sessionId);
  if (!effectivePreset) {
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "ignored-message",
      reason: "no-active-mode",
      botToken: context.botToken,
      sessionId,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      replyToMessageId: typeof replyToMessageId === "number" ? replyToMessageId : null,
    });
    return;
  }

  const targetSession = findTelegramSessionById(context.db, sessionId);
  if (effectivePreset === "passive" && targetSession) {
    const passiveResult = await handlePassiveReplyDelivery({
      db: context.db,
      targetSession,
      promptText: context.trimmedText,
      message: context.message,
    });
    await sendTelegramBridgeMessage(context.botToken, context.chatId, passiveResult.ackText);
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "queue-prompt",
      botToken: context.botToken,
      sessionId,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      replyToMessageId: typeof replyToMessageId === "number" ? replyToMessageId : null,
      preset: effectivePreset,
    });
    return;
  }

  const stored = upsertSessionRemotePrompt(
    context.db,
    sessionId,
    context.trimmedText,
    getTelegramRemotePromptDeliveryMode(effectivePreset),
    context.message,
  );
  if (stored && targetSession) {
    await sendTelegramBridgeMessage(
      context.botToken,
      context.chatId,
      buildTelegramPromptReceivedText(targetSession),
    );
  }
  await appendHookDebugLog(context.paths, {
    type: "telegram-bridge",
    action: stored ? "queue-prompt" : "ignored-message",
    reason: stored ? undefined : "empty-text",
    botToken: context.botToken,
    sessionId,
    updateId: context.update.update_id ?? null,
    chatId: context.chatId,
    replyToMessageId: typeof replyToMessageId === "number" ? replyToMessageId : null,
  });
}

async function processTelegramBridgeUpdate(
  paths: LoopndrollPaths,
  db: Database,
  botToken: string,
  update: TelegramUpdate,
) {
  const context = createTelegramBridgeUpdateContext(paths, db, botToken, update);
  if (!context || !(await prepareTelegramBridgeUpdate(context, isAuthorizedTelegramBridgeChat))) {
    return;
  }

  const runtimeState = getLoopndrollRuntimeState(db);
  const commandName = getTelegramCommandName(context.trimmedText);
  if (runtimeState !== "running" && commandName !== "status" && commandName !== "help") {
    await sendTelegramBridgeMessage(
      context.botToken,
      context.chatId,
      `Loopndroll is ${runtimeState}. Use the app to ${runtimeState === "paused" ? "resume" : "start"} it first.`,
    );
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "ignored-message",
      reason: `runtime-${runtimeState}`,
      botToken: context.botToken,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      commandName,
    });
    return;
  }

  if (commandName && (await handleTelegramBridgeCommand(context, commandName))) {
    return;
  }
  if (commandName) {
    await appendHookDebugLog(context.paths, {
      type: "telegram-bridge",
      action: "ignored-command",
      botToken: context.botToken,
      updateId: context.update.update_id ?? null,
      chatId: context.chatId,
      commandName,
    });
    return;
  }

  await handleFreeformTelegramMessage(context);
}

let telegramBridgeStarted = false;
let telegramBridgePolling = false;

async function pollTelegramReplies() {
  const paths = getLoopndrollPaths();
  const { client } = getLoopndrollDatabase(paths.databasePath);
  if (getLoopndrollRuntimeState(client) === "stopped") {
    return;
  }
  const botTokens = getTelegramBridgeBotTokens(client);

  for (const botToken of botTokens) {
    const cursor = getTelegramUpdateCursor(client, botToken);
    const updates = await fetchTelegramUpdates(
      botToken,
      typeof cursor === "number" ? cursor + 1 : undefined,
    );
    if (updates.length === 0) {
      continue;
    }

    const lastUpdateId = updates.reduce((max, update) => {
      return typeof update.update_id === "number" && update.update_id > max
        ? update.update_id
        : max;
    }, cursor ?? -1);

    for (const update of updates) {
      await processTelegramBridgeUpdate(paths, client, botToken, update);
    }

    setTelegramUpdateCursor(client, botToken, lastUpdateId);
  }
}

export function startLoopndrollTelegramBridge() {
  if (telegramBridgeStarted) {
    return;
  }

  telegramBridgeStarted = true;

  const runPoll = async () => {
    if (telegramBridgePolling) {
      return;
    }

    telegramBridgePolling = true;
    try {
      await pollTelegramReplies();
    } catch (error) {
      await appendHookDebugLog(getLoopndrollPaths(), {
        type: "telegram-bridge",
        action: "poll-error",
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {
        // Ignore logging failures while preserving the bridge loop.
      });
    } finally {
      telegramBridgePolling = false;
    }
  };

  void runPoll();
  setInterval(() => {
    void runPoll();
  }, TELEGRAM_BRIDGE_POLL_INTERVAL_MS);
}
