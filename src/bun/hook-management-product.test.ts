import { describe, expect, test } from "bun:test";
import type { LoopndrollSnapshot } from "../shared/app-rpc";

import { buildLoopndrollSetupSnapshot } from "./hook-management";

describe("buildLoopndrollSetupSnapshot", () => {
  test("returns a product-facing setup snapshot with runtime state and hook health", () => {
    const baseSnapshot = {
      defaultPrompt: "Keep going",
      scope: "global",
      runtimeState: "running",
      globalPreset: null,
      globalNotificationId: null,
      globalCompletionCheckId: null,
      globalCompletionCheckWaitForReply: false,
      hooksAutoRegistration: true,
      notifications: [],
      completionChecks: [],
      health: {
        registered: true,
        issues: [],
      },
      sessions: [],
    } satisfies LoopndrollSnapshot;

    const snapshot = buildLoopndrollSetupSnapshot(baseSnapshot, {
      registered: false,
      issues: ["Managed Stop hook is not registered."],
    });

    expect(snapshot.runtimeState).toBe("running");
    expect(snapshot.hooksAutoRegistration).toBe(true);
    expect(snapshot.health.registered).toBe(false);
    expect(snapshot.health.issues).toEqual(["Managed Stop hook is not registered."]);
  });
});
