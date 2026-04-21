import { describe, expect, test } from "bun:test";

import { buildManagedHookScript } from "./managed-hook-script";
import { MANAGED_HOOK_SCRIPT_CHUNK_3 } from "./managed-hook-script/chunk-3";

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
  test("does not emit escaped backticks into the hook source", () => {
    const script = buildManagedHookScript({
      appDirectoryPath: "/tmp/app",
      binDirectoryPath: "/tmp/app/bin",
      logsDirectoryPath: "/tmp/app/logs",
      databasePath: "/tmp/app/app.db",
      managedHookPath: "/tmp/app/bin/loopndroll-hook",
      hookDebugLogPath: "/tmp/app/logs/hooks-debug.jsonl",
      codexDirectoryPath: "/tmp/.codex",
      codexConfigPath: "/tmp/.codex/config.toml",
      codexHooksPath: "/tmp/.codex/hooks.json",
    });

    expect(script).not.toContain("\\`");
  });

  test("includes the telegram output helpers needed at runtime", () => {
    const script = buildManagedHookScript({
      appDirectoryPath: "/tmp/app",
      binDirectoryPath: "/tmp/app/bin",
      logsDirectoryPath: "/tmp/app/logs",
      databasePath: "/tmp/app/app.db",
      managedHookPath: "/tmp/app/bin/loopndroll-hook",
      hookDebugLogPath: "/tmp/app/logs/hooks-debug.jsonl",
      codexDirectoryPath: "/tmp/.codex",
      codexConfigPath: "/tmp/.codex/config.toml",
      codexHooksPath: "/tmp/.codex/hooks.json",
    });

    expect(script).toContain("function compactWhitespace(value)");
    expect(script).toContain("function buildTelegramNotificationChunks(input)");
  });
});
