import { describe, expect, test } from "bun:test";

import { buildTelegramHelpText, buildTelegramStatusText } from "./telegram-bridge-text";

describe("buildTelegramStatusText", () => {
  test("shows runtime state and paused guidance", () => {
    const text = buildTelegramStatusText(
      {
        scope: "global",
        runtimeState: "paused",
        globalPreset: "passive",
        hooksAutoRegistration: true,
      },
      [],
    );

    expect(text).toContain("System: paused");
    expect(text).toContain("Hooks auto-registration: On");
    expect(text).toContain("Global preset: Passive");
    expect(text).toContain("Remote control is paused.");
  });

  test("shows stopped guidance", () => {
    const text = buildTelegramStatusText(
      {
        scope: "global",
        runtimeState: "stopped",
        globalPreset: null,
        hooksAutoRegistration: false,
      },
      [],
    );

    expect(text).toContain("System: stopped");
    expect(text).toContain("Hooks auto-registration: Off");
    expect(text).toContain("Loopndroll is stopped.");
  });
});

describe("buildTelegramHelpText", () => {
  test("describes reply behavior and passive mode clearly", () => {
    const text = buildTelegramHelpText();

    expect(text).toContain("/reply C22 your message - Fallback: send a prompt to a specific chat");
    expect(text).toContain("Use /reply only as a fallback");
    expect(text).toContain("Passive: sends a notification, does not keep Codex waiting");
  });
});
