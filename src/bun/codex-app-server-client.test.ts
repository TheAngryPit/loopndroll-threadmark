import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import {
  attemptPassiveWakeViaCodexAppServer,
  createCodexAppServerTransportFromChild,
  listThreadsForCwdViaCodexAppServer,
  resolveCanonicalThreadTarget,
} from "./codex-app-server-client";

describe("attemptPassiveWakeViaCodexAppServer", () => {
  test("initializes, resumes, and starts a turn", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, result: { thread: { id: "thr_123" } } },
      { id: 3, result: { turn: { id: "turn_456", status: "inProgress" } } },
    ];

    const result = await attemptPassiveWakeViaCodexAppServer(
      {
        sent,
        async readMessage() {
          return messages.shift();
        },
        async writeMessage(message) {
          sent.push(message);
        },
        async close() {},
      },
      {
        threadId: "thr_123",
        prompt: "Continue with the Telegram reply.",
        cwd: "/tmp/project",
      },
    );

    expect(result).toEqual({
      status: "accepted",
      threadId: "thr_123",
      turnId: "turn_456",
    });
  });

  test("fails closed when resume is rejected", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, error: { code: 404, message: "thread not found" } },
    ];

    const result = await attemptPassiveWakeViaCodexAppServer(
      {
        sent,
        async readMessage() {
          return messages.shift();
        },
        async writeMessage(message) {
          sent.push(message);
        },
        async close() {},
      },
      {
        threadId: "thr_missing",
        prompt: "Continue with the Telegram reply.",
      },
    );

    expect(result).toEqual({
      status: "failed",
      reason: "thread-resume-failed",
      detail: "thread not found",
    });
  });
});

describe("createCodexAppServerTransportFromChild", () => {
  test("writes newline-delimited JSON, reads one parsed line, and closes the child", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    let killed = false;

    stdin.on("data", (chunk) => {
      written.push(chunk.toString("utf8"));
    });

    const transport = createCodexAppServerTransportFromChild({
      stdin,
      stdout,
      kill() {
        killed = true;
      },
    });

    await transport.writeMessage({ id: 9, method: "ping", params: { ok: true } });
    stdout.write(`${JSON.stringify({ id: 9, result: { pong: true } })}\n`);

    await expect(transport.readMessage()).resolves.toEqual({
      id: 9,
      result: { pong: true },
    });
    expect(written).toEqual(['{"id":9,"method":"ping","params":{"ok":true}}\n']);

    await transport.close();

    expect(killed).toBe(true);
  });

  test("fails closed and kills the child when stdout is missing during setup", () => {
    const stdin = new PassThrough();
    let killed = false;

    expect(() =>
      createCodexAppServerTransportFromChild({
        stdin,
        stdout: undefined as never,
        kill() {
          killed = true;
        },
      }),
    ).toThrow();

    expect(killed).toBe(true);
  });
});

describe("listThreadsForCwdViaCodexAppServer", () => {
  test("parses canonical discovery records from thread/list", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      {
        id: 2,
        result: {
          data: [
            {
              id: "thr_123",
              name: "Fix passive wake",
              cwd: "/tmp/project",
            },
            {
              id: "thr_999",
              name: null,
              cwd: "/tmp/project",
            },
          ],
        },
      },
    ];

    const result = await listThreadsForCwdViaCodexAppServer(
      {
        sent,
        async readMessage() {
          return messages.shift();
        },
        async writeMessage(message) {
          sent.push(message);
        },
        async close() {},
      },
      "/tmp/project",
    );

    expect(result).toEqual([
      {
        threadId: "thr_123",
        threadName: "Fix passive wake",
        cwd: "/tmp/project",
      },
      {
        threadId: "thr_999",
        threadName: null,
        cwd: "/tmp/project",
      },
    ]);
  });
});

describe("resolveCanonicalThreadTarget", () => {
  test("prefers stored threadId, else unique discovery match, else fails closed", () => {
    expect(
      resolveCanonicalThreadTarget({
        storedThreadId: "thr_stored",
        discoveredThreads: [
          {
            threadId: "thr_123",
            threadName: "Fix passive wake",
            cwd: "/tmp/project",
          },
        ],
      }),
    ).toBe("thr_stored");

    expect(
      resolveCanonicalThreadTarget({
        storedThreadId: null,
        discoveredThreads: [
          {
            threadId: "thr_123",
            threadName: "Fix passive wake",
            cwd: "/tmp/project",
          },
        ],
      }),
    ).toBe("thr_123");

    expect(
      resolveCanonicalThreadTarget({
        storedThreadId: null,
        discoveredThreads: [
          {
            threadId: "thr_123",
            threadName: "Fix passive wake",
            cwd: "/tmp/project",
          },
          {
            threadId: "thr_999",
            threadName: "Another thread",
            cwd: "/tmp/project",
          },
        ],
      }),
    ).toBeNull();
  });
});
