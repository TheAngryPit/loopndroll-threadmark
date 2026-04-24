import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import {
  attemptPassiveWakeViaCodexAppServer,
  createCodexAppServerTransportFromChild,
  inspectCodexRuntimeActivity,
  keepCodexAppServerTransportAliveUntilThreadInactive,
  listThreadsForCwdViaCodexAppServer,
  resolveCanonicalThreadTarget,
} from "./codex-app-server-client";

function createMemoryTransport(messages: unknown[], sent: unknown[] = []) {
  return {
    sent,
    async readMessage() {
      return messages.shift();
    },
    async writeMessage(message: unknown) {
      sent.push(message);
    },
    async close() {},
  };
}

function createPollingTransport(input: {
  sent: unknown[];
  readMessage: (messageId: number) => Promise<unknown> | unknown;
  close: () => void;
}) {
  return {
    sent: input.sent,
    async readMessage() {
      const messageId =
        typeof (input.sent.at(-1) as { id?: unknown } | undefined)?.id === "number"
          ? (input.sent.at(-1) as { id: number }).id
          : 0;
      return input.readMessage(messageId);
    },
    async writeMessage(message: unknown) {
      input.sent.push(message);
    },
    async close() {
      input.close();
    },
  };
}

describe("attemptPassiveWakeViaCodexAppServer", () => {
  test("initializes, resumes, and starts a turn", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, result: { thread: { id: "thr_123" } } },
      { id: 3, result: { thread: { id: "thr_123", status: { type: "idle" }, turns: [] } } },
      { id: 4, result: { turn: { id: "turn_456", status: "inProgress" } } },
      { id: 5, result: { thread: { id: "thr_123", status: { type: "active" } } } },
    ];

    const result = await attemptPassiveWakeViaCodexAppServer(
      createMemoryTransport(messages, sent),
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

  test("ignores app-server notifications while waiting for matching RPC responses", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      {
        method: "mcpServer/startupStatus/updated",
        params: { name: "xcode", status: "starting" },
      },
      { id: 2, result: { thread: { id: "thr_123" } } },
      {
        method: "mcpServer/startupStatus/updated",
        params: { name: "computer-use", status: "starting" },
      },
      { id: 3, result: { thread: { id: "thr_123", status: { type: "idle" }, turns: [] } } },
      {
        method: "mcpServer/startupStatus/updated",
        params: { name: "computer-use", status: "running" },
      },
      { id: 4, result: { turn: { id: "turn_456", status: "inProgress" } } },
      { id: 5, result: { thread: { id: "thr_123", status: { type: "active" } } } },
    ];

    const result = await attemptPassiveWakeViaCodexAppServer(
      createMemoryTransport(messages, sent),
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
});

describe("attemptPassiveWakeViaCodexAppServer active turn", () => {
  test("steers an active turn instead of starting a competing turn", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, result: { thread: { id: "thr_123" } } },
      {
        id: 3,
        result: {
          thread: {
            id: "thr_123",
            status: { type: "active" },
            turns: [{ id: "turn_active", status: "inProgress" }],
          },
        },
      },
      { id: 4, result: { turnId: "turn_active" } },
    ];

    const result = await attemptPassiveWakeViaCodexAppServer(
      createMemoryTransport(messages, sent),
      {
        threadId: "thr_123",
        prompt: "Continue with the Telegram reply.",
      },
    );

    expect(result).toEqual({
      status: "accepted",
      threadId: "thr_123",
      turnId: "turn_active",
    });
    expect(sent.at(-1)).toEqual({
      id: 4,
      method: "turn/steer",
      params: {
        threadId: "thr_123",
        expectedTurnId: "turn_active",
        input: [{ type: "text", text: "Continue with the Telegram reply." }],
      },
    });
  });
});

describe("attemptPassiveWakeViaCodexAppServer failure handling", () => {
  test("fails closed when resume is rejected", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, error: { code: 404, message: "thread not found" } },
    ];

    const result = await attemptPassiveWakeViaCodexAppServer(
      createMemoryTransport(messages, sent),
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

  test("does not report accepted when turn/start returns but the thread is not active", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, result: { thread: { id: "thr_123" } } },
      { id: 3, result: { thread: { id: "thr_123", status: { type: "idle" }, turns: [] } } },
      { id: 4, result: { turn: { id: "turn_456", status: "inProgress" } } },
      { id: 5, result: { thread: { id: "thr_123", status: { type: "idle" } } } },
      { id: 6, result: { thread: { id: "thr_123", status: { type: "idle" } } } },
      { id: 7, result: { thread: { id: "thr_123", status: { type: "idle" } } } },
      { id: 8, result: { thread: { id: "thr_123", status: { type: "idle" } } } },
    ];

    const result = await attemptPassiveWakeViaCodexAppServer(
      createMemoryTransport(messages, sent),
      {
        threadId: "thr_123",
        prompt: "Continue with the Telegram reply.",
      },
    );

    expect(result).toEqual({
      status: "failed",
      reason: "thread-not-working-after-turn-start",
      detail: "thread-status-idle",
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
      createMemoryTransport(messages, sent),
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

describe("inspectCodexRuntimeActivity", () => {
  test("reports idle when no threads are loaded", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, result: { data: [] } },
    ];

    const result = await inspectCodexRuntimeActivity(createMemoryTransport(messages, sent));

    expect(result).toEqual({
      status: "idle",
      loadedThreadIds: [],
      activeThreadIds: [],
      reason: null,
    });
  });

  test("reports active when any loaded thread has active runtime status", async () => {
    const sent: unknown[] = [];
    const messages = [
      { id: 1, result: { serverInfo: { name: "codex-app-server" } } },
      { id: 2, result: { data: ["thr_idle", "thr_active"] } },
      { id: 3, result: { thread: { id: "thr_idle", status: { type: "idle" } } } },
      {
        id: 4,
        result: {
          thread: {
            id: "thr_active",
            status: { type: "active", activeFlags: ["waitingOnApproval"] },
          },
        },
      },
    ];

    const result = await inspectCodexRuntimeActivity(createMemoryTransport(messages, sent));

    expect(result).toEqual({
      status: "active",
      loadedThreadIds: ["thr_idle", "thr_active"],
      activeThreadIds: ["thr_active"],
      reason: "active-thread-status",
    });
  });
});

describe("keepCodexAppServerTransportAliveUntilThreadInactive", () => {
  test("keeps polling while the started turn is running and closes after it is completed", async () => {
    let closed = false;
    const sent: unknown[] = [];
    const transport = createPollingTransport({
      sent,
      readMessage(messageId) {
        if (messageId === 10) {
          return {
            id: 10,
            result: {
              thread: {
                id: "thr_123",
                status: { type: "idle" },
                turns: [{ id: "turn_1", status: "inProgress" }],
              },
            },
          };
        }
        return {
          id: messageId,
          result: {
            thread: {
              id: "thr_123",
              status: { type: "idle" },
              turns: [{ id: "turn_1", status: "completed" }],
            },
          },
        };
      },
      close() {
        closed = true;
      },
    });

    const result = await keepCodexAppServerTransportAliveUntilThreadInactive(transport, {
      threadId: "thr_123",
      turnId: "turn_1",
      pollIntervalMs: 0,
      maxDurationMs: 1_000,
      firstRequestId: 10,
    });

    expect(result).toEqual({
      status: "finished",
      lastThreadStatusType: "idle",
      lastTurnStatus: "completed",
    });
    expect(closed).toBe(true);
    expect(sent).toEqual([
      {
        id: 10,
        method: "thread/read",
        params: { threadId: "thr_123", includeTurns: true },
      },
      {
        id: 11,
        method: "thread/read",
        params: { threadId: "thr_123", includeTurns: true },
      },
    ]);
  });
});

describe("keepCodexAppServerTransportAliveUntilThreadInactive notifications", () => {
  test("forwards app-server notifications observed during keepalive polling", async () => {
    let closed = false;
    let notificationReturned = false;
    const sent: unknown[] = [];
    const observedNotifications: unknown[] = [];
    const transport = createPollingTransport({
      sent,
      readMessage(messageId) {
        if (!notificationReturned) {
          notificationReturned = true;
          return {
            method: "item/completed",
            params: { item: { type: "agentMessage", text: "Done from app-server." } },
          };
        }
        return {
          id: messageId,
          result: {
            thread: {
              id: "thr_123",
              status: { type: "idle" },
              turns: [{ id: "turn_1", status: "completed" }],
            },
          },
        };
      },
      close() {
        closed = true;
      },
    });

    const result = await keepCodexAppServerTransportAliveUntilThreadInactive(transport, {
      threadId: "thr_123",
      turnId: "turn_1",
      pollIntervalMs: 0,
      maxDurationMs: 1_000,
      firstRequestId: 10,
      onNotification(notification) {
        observedNotifications.push(notification);
      },
    });

    expect(result.status).toBe("finished");
    expect(observedNotifications).toEqual([
      {
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "Done from app-server." } },
      },
    ]);
    expect(closed).toBe(true);
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
