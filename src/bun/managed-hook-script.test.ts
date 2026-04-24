import { describe, expect, test } from "bun:test";

import { buildManagedHookScript, normalizeRuntimeStateHelperName } from "./managed-hook-script";
import { MANAGED_HOOK_SCRIPT_CHUNK_3 } from "./managed-hook-script/chunk-3";

function createTestPaths() {
  return {
    appDirectoryPath: "/tmp/app",
    binDirectoryPath: "/tmp/app/bin",
    stateDirectoryPath: "/tmp/app/state",
    logsDirectoryPath: "/tmp/app/logs",
    databasePath: "/tmp/app/app.db",
    managedHookPath: "/tmp/app/bin/loopndroll-hook",
    hookRemovalWatchLockPath: "/tmp/app/state/hook-removal-watch.lock",
    hookDebugLogPath: "/tmp/app/logs/hooks-debug.jsonl",
    codexDirectoryPath: "/tmp/.codex",
    codexConfigPath: "/tmp/.codex/config.toml",
    codexHooksPath: "/tmp/.codex/hooks.json",
  };
}

describe("MANAGED_HOOK_SCRIPT_CHUNK_3", () => {
  test("embeds the runtime-state guard directly in the generated source", () => {
    const script = MANAGED_HOOK_SCRIPT_CHUNK_3;

    expect(script).toContain("const runtimeState = getLoopndrollRuntimeState(db);");
    expect(script).toContain('if (runtimeState !== "running") {');
    expect(script).toContain("reason: `runtime-${runtimeState}`");
    expect(script).toContain("sessionId: input.session_id");
  });
});

describe("buildManagedHookScript", () => {
  test("normalizes bundled runtime-state helper names back to the chunk contract", () => {
    const source = "function getLoopndrollRuntimeState2(db) { return 'running'; }";

    expect(normalizeRuntimeStateHelperName(source)).toBe(
      "function getLoopndrollRuntimeState(db) { return 'running'; }",
    );
  });

  test("defines the exact runtime-state helper name used by the hook body", () => {
    const script = buildManagedHookScript(createTestPaths());

    expect(script).toContain("function getLoopndrollRuntimeState(db)");
    expect(script).toContain("const runtimeState = getLoopndrollRuntimeState(db);");
    expect(script).not.toContain("function getLoopndrollRuntimeState2(");
  });

  test("does not emit escaped backticks into the hook source", () => {
    const script = buildManagedHookScript(createTestPaths());

    expect(script).not.toContain("\\`");
  });

  test("includes the telegram output helpers needed at runtime", () => {
    const script = buildManagedHookScript(createTestPaths());

    expect(script).toContain("function compactWhitespace(value)");
    expect(script).toContain("function buildTelegramNotificationChunks(input)");
  });

  test("preserves passive preset semantics in the generated hook", () => {
    const script = buildManagedHookScript(createTestPaths());

    expect(script).toContain('value === "passive"');
    expect(script).toContain('preset === "passive"');
    expect(script).toContain(
      "Reply to this message in Telegram to queue the next prompt for this Codex chat.",
    );
  });

  test("targets current thread_id schema while preserving Codex session_id input", () => {
    const script = buildManagedHookScript(createTestPaths());

    expect(script).toContain("input.session_id");
    expect(script).toContain("thread_id as session_id");
    expect(script).toContain("thread_name as title");
    expect(script).toContain("where thread_id = ?");
    expect(script).toContain("where s.thread_id = ?");
    expect(script).toContain("where sn.thread_id = ?");
    expect(script).toContain("update sessions set thread_name = ? where thread_id = ?");
    expect(script).not.toContain("where session_id = ?");
    expect(script).not.toContain("where s.session_id = ?");
    expect(script).not.toContain("where sn.session_id = ?");
    expect(script).not.toContain("select session_ref, title, archived, cwd");
    expect(script).not.toContain("update sessions set title = ?");
    expect(script).not.toContain("insert into sessions (\\n          session_id,");
  });
});
