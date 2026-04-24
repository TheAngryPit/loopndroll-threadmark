import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type CodexAppServerTransport = {
  sent: unknown[];
  readMessage: () => Promise<unknown>;
  writeMessage: (message: unknown) => Promise<void>;
  close: () => Promise<void>;
};

export type PassiveWakeInput = {
  threadId: string;
  prompt: string;
  cwd?: string | null;
};

export type PassiveWakeResult =
  | { status: "accepted"; threadId: string; turnId: string | null }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string; detail: string | null };

export type PassiveWakeKeepAliveResult =
  | { status: "finished"; lastThreadStatusType: string | null; lastTurnStatus: string | null }
  | { status: "timeout"; lastStatusType: string | null }
  | { status: "failed"; detail: string };

export type CanonicalThreadDiscoveryRecord = {
  threadId: string;
  threadName: string | null;
  cwd: string | null;
};

export type CodexRuntimeActivityInspection = {
  status: "idle" | "active" | "unknown";
  loadedThreadIds: string[];
  activeThreadIds: string[];
  reason: string | null;
};

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
};

type LocalCodexAppServerChild = {
  stdin: Writable;
  stdout: Readable;
  kill: () => void;
};

function failClosedTransportStartup(
  child: Pick<LocalCodexAppServerChild, "kill">,
  message: string,
): never {
  child.kill();
  throw new Error(message);
}

function createReadMessage(lines: string[]) {
  return async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const line = lines.shift();
      if (line) {
        return JSON.parse(line);
      }
      await Bun.sleep(25);
    }
    throw new Error("app-server-timeout");
  };
}

export function createCodexAppServerTransportFromChild(
  child: LocalCodexAppServerChild,
): CodexAppServerTransport {
  if (!child.stdin) {
    failClosedTransportStartup(child, "app-server-stdin-missing");
  }
  if (!child.stdout) {
    failClosedTransportStartup(child, "app-server-stdout-missing");
  }

  const sent: unknown[] = [];
  const lines: string[] = [];
  let readline;
  try {
    readline = createInterface({ input: child.stdout });
  } catch {
    failClosedTransportStartup(child, "app-server-transport-setup-failed");
  }
  readline.on("line", (line) => lines.push(line));

  return {
    sent,
    readMessage: createReadMessage(lines),
    async writeMessage(message) {
      sent.push(message);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      readline.close();
      child.kill();
    },
  };
}

export async function createSpawnedCodexAppServerTransport(): Promise<CodexAppServerTransport> {
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  });

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("app-server-transport-setup-failed");
  }

  return createCodexAppServerTransportFromChild({
    stdin: child.stdin,
    stdout: child.stdout,
    kill() {
      child.kill();
    },
  });
}

async function rpcCall(
  transport: CodexAppServerTransport,
  id: number,
  method: string,
  params: Record<string, unknown>,
  onNotification?: (notification: CodexAppServerNotification) => void | Promise<void>,
) {
  await transport.writeMessage({ id, method, params });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = (await transport.readMessage()) as
      | {
          id?: number;
          method?: string;
          params?: unknown;
          result?: Record<string, unknown>;
          error?: { message?: string };
        }
      | undefined;
    if (typeof message?.method === "string") {
      await onNotification?.({ method: message.method, params: message.params });
      continue;
    }
    if (message?.id === id) {
      return message as
        | {
            id: number;
            result?: Record<string, unknown>;
            error?: { message?: string };
          }
        | undefined;
    }
  }

  throw new Error(`app-server-response-timeout:${method}`);
}

async function initializeCodexAppServerConnection(transport: CodexAppServerTransport) {
  const init = await rpcCall(transport, 1, "initialize", {
    clientInfo: {
      name: "loopndroll",
      title: "Loopndroll",
      version: "1.1.5",
    },
  });
  if (!init?.result) {
    return false;
  }

  await transport.writeMessage({ method: "initialized", params: {} });
  return true;
}

function getThreadStatusType(thread: unknown) {
  if (typeof thread !== "object" || thread === null || !("status" in thread)) {
    return null;
  }

  const status = thread.status;
  return typeof status === "object" &&
    status !== null &&
    "type" in status &&
    typeof status.type === "string"
    ? status.type
    : null;
}

function getTurnStatus(thread: unknown, turnId: string | null) {
  if (turnId === null || typeof thread !== "object" || thread === null || !("turns" in thread)) {
    return null;
  }

  const turns = thread.turns;
  if (!Array.isArray(turns)) {
    return null;
  }

  const turn = turns.find((candidate) => {
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      "id" in candidate &&
      candidate.id === turnId
    );
  });
  if (typeof turn !== "object" || turn === null || !("status" in turn)) {
    return null;
  }

  return typeof turn.status === "string" ? turn.status : null;
}

function getActiveTurnId(thread: unknown) {
  if (typeof thread !== "object" || thread === null || !("turns" in thread)) {
    return null;
  }

  const turns = thread.turns;
  if (!Array.isArray(turns)) {
    return null;
  }

  for (const turn of turns.toReversed()) {
    if (
      typeof turn === "object" &&
      turn !== null &&
      "id" in turn &&
      typeof turn.id === "string" &&
      "status" in turn &&
      turn.status === "inProgress"
    ) {
      return turn.id;
    }
  }

  return null;
}

function isTerminalTurnStatus(status: string | null) {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

async function waitForActiveThreadStatus(
  transport: CodexAppServerTransport,
  threadId: string,
  firstRequestId: number,
) {
  let lastStatusType: string | null = null;
  const delaysMs = [0, 100, 250, 500];

  for (const [index, delayMs] of delaysMs.entries()) {
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }

    const read = await rpcCall(transport, firstRequestId + index, "thread/read", {
      threadId,
      includeTurns: false,
    });
    if (!read?.result) {
      return {
        active: false,
        detail: read?.error?.message ?? "thread-read-failed",
      };
    }

    lastStatusType = getThreadStatusType(read.result.thread);
    if (lastStatusType === "active") {
      return {
        active: true,
        detail: null,
      };
    }
  }

  return {
    active: false,
    detail: lastStatusType ? `thread-status-${lastStatusType}` : "thread-status-unknown",
  };
}

async function steerActiveCodexTurn(input: {
  transport: CodexAppServerTransport;
  threadId: string;
  prompt: string;
  currentThread: unknown;
}): Promise<PassiveWakeResult> {
  const activeTurnId = getActiveTurnId(input.currentThread);
  if (activeTurnId === null) {
    return {
      status: "failed",
      reason: "active-turn-id-unavailable",
      detail: null,
    };
  }

  const steered = await rpcCall(input.transport, 4, "turn/steer", {
    threadId: input.threadId,
    expectedTurnId: activeTurnId,
    input: [{ type: "text", text: input.prompt }],
  });
  if (!steered?.result?.turnId) {
    return {
      status: "failed",
      reason: "turn-steer-failed",
      detail: steered?.error?.message ?? null,
    };
  }

  return {
    status: "accepted",
    threadId: input.threadId,
    turnId: typeof steered.result.turnId === "string" ? steered.result.turnId : activeTurnId,
  };
}

async function startIdleCodexTurn(input: {
  transport: CodexAppServerTransport;
  threadId: string;
  prompt: string;
  cwd?: string | null;
}): Promise<PassiveWakeResult> {
  const started = await rpcCall(input.transport, 4, "turn/start", {
    threadId: input.threadId,
    cwd: input.cwd ?? undefined,
    input: [{ type: "text", text: input.prompt }],
  });
  if (!started?.result?.turn) {
    return {
      status: "failed",
      reason: "turn-start-failed",
      detail: started?.error?.message ?? null,
    };
  }

  const turn = started.result.turn;
  const turnId =
    typeof turn === "object" && turn !== null && "id" in turn && typeof turn.id === "string"
      ? turn.id
      : null;

  const activeStatus = await waitForActiveThreadStatus(input.transport, input.threadId, 5);
  if (!activeStatus.active) {
    return {
      status: "failed",
      reason: "thread-not-working-after-turn-start",
      detail: activeStatus.detail,
    };
  }

  return {
    status: "accepted",
    threadId: input.threadId,
    turnId,
  };
}

export async function inspectCodexRuntimeActivity(
  transport: CodexAppServerTransport,
): Promise<CodexRuntimeActivityInspection> {
  try {
    if (!(await initializeCodexAppServerConnection(transport))) {
      return {
        status: "unknown",
        loadedThreadIds: [],
        activeThreadIds: [],
        reason: "initialize-failed",
      };
    }

    const listed = await rpcCall(transport, 2, "thread/loaded/list", {});
    const loadedThreadIds = Array.isArray(listed?.result?.data)
      ? listed.result.data.filter((threadId): threadId is string => typeof threadId === "string")
      : [];

    if (!listed?.result || loadedThreadIds.length === 0) {
      return {
        status: listed?.result ? "idle" : "unknown",
        loadedThreadIds,
        activeThreadIds: [],
        reason: listed?.result ? null : (listed?.error?.message ?? "loaded-list-failed"),
      };
    }

    const activeThreadIds: string[] = [];
    for (const [index, threadId] of loadedThreadIds.entries()) {
      const read = await rpcCall(transport, 3 + index, "thread/read", {
        threadId,
        includeTurns: false,
      });
      const statusType = getThreadStatusType(read?.result?.thread);
      if (statusType === "active") {
        activeThreadIds.push(threadId);
      }
      if (!read?.result || statusType === null) {
        return {
          status: "unknown",
          loadedThreadIds,
          activeThreadIds,
          reason: read?.error?.message ?? "thread-status-unknown",
        };
      }
    }

    return {
      status: activeThreadIds.length > 0 ? "active" : "idle",
      loadedThreadIds,
      activeThreadIds,
      reason: activeThreadIds.length > 0 ? "active-thread-status" : null,
    };
  } catch (error) {
    return {
      status: "unknown",
      loadedThreadIds: [],
      activeThreadIds: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function keepCodexAppServerTransportAliveUntilThreadInactive(
  transport: CodexAppServerTransport,
  input: {
    threadId: string;
    turnId?: string | null;
    pollIntervalMs?: number;
    maxDurationMs?: number;
    firstRequestId?: number;
    onNotification?: (notification: CodexAppServerNotification) => void | Promise<void>;
  },
): Promise<PassiveWakeKeepAliveResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const maxDurationMs = input.maxDurationMs ?? 60 * 60 * 1_000;
  const deadline = Date.now() + maxDurationMs;
  let requestId = input.firstRequestId ?? 1_000;
  let lastThreadStatusType: string | null = null;
  let lastTurnStatus: string | null = null;

  try {
    while (Date.now() < deadline) {
      await Bun.sleep(pollIntervalMs);
      const read = await rpcCall(
        transport,
        requestId,
        "thread/read",
        {
          threadId: input.threadId,
          includeTurns: Boolean(input.turnId),
        },
        input.onNotification,
      );
      requestId += 1;

      if (!read?.result) {
        return {
          status: "failed",
          detail: read?.error?.message ?? "thread-read-failed",
        };
      }

      lastThreadStatusType = getThreadStatusType(read.result.thread);
      lastTurnStatus = getTurnStatus(read.result.thread, input.turnId ?? null);
      if (input.turnId && isTerminalTurnStatus(lastTurnStatus)) {
        return {
          status: "finished",
          lastThreadStatusType,
          lastTurnStatus,
        };
      }
      if (!input.turnId && lastThreadStatusType !== "active") {
        return {
          status: "finished",
          lastThreadStatusType,
          lastTurnStatus: null,
        };
      }
    }

    return {
      status: "timeout",
      lastStatusType: input.turnId
        ? (lastTurnStatus ?? lastThreadStatusType)
        : lastThreadStatusType,
    };
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await transport.close().catch(() => {
      // Preserve the keepalive result; cleanup failures are not actionable here.
    });
  }
}

export async function listThreadsForCwdViaCodexAppServer(
  transport: CodexAppServerTransport,
  cwd: string,
): Promise<CanonicalThreadDiscoveryRecord[]> {
  const trimmedCwd = cwd.trim();
  if (trimmedCwd.length === 0) {
    return [];
  }

  if (!(await initializeCodexAppServerConnection(transport))) {
    return [];
  }

  const listed = await rpcCall(transport, 2, "thread/list", {
    cwd: trimmedCwd,
  });

  const rows = Array.isArray(listed?.result?.data) ? listed.result.data : [];
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string") {
      return [];
    }

    const threadName =
      "name" in row && typeof row.name === "string"
        ? row.name
        : "name" in row && row.name === null
          ? null
          : null;

    const resolvedCwd =
      "cwd" in row && typeof row.cwd === "string"
        ? row.cwd
        : "cwd" in row && row.cwd === null
          ? null
          : trimmedCwd;

    return [
      {
        threadId: row.id,
        threadName,
        cwd: resolvedCwd,
      } satisfies CanonicalThreadDiscoveryRecord,
    ];
  });
}

export function resolveCanonicalThreadTarget(input: {
  storedThreadId: string | null;
  discoveredThreads: CanonicalThreadDiscoveryRecord[];
}): string | null {
  const storedThreadId = input.storedThreadId?.trim() ?? "";
  if (storedThreadId.length > 0) {
    return storedThreadId;
  }

  return input.discoveredThreads.length === 1
    ? (input.discoveredThreads[0]?.threadId ?? null)
    : null;
}

export async function attemptPassiveWakeViaCodexAppServer(
  transport: CodexAppServerTransport,
  input: PassiveWakeInput,
): Promise<PassiveWakeResult> {
  const threadId = input.threadId.trim();
  const prompt = input.prompt.trim();

  if (threadId.length === 0 || prompt.length === 0) {
    return { status: "failed", reason: "invalid-input", detail: null };
  }

  if (!(await initializeCodexAppServerConnection(transport))) {
    return {
      status: "unavailable",
      reason: "initialize-failed",
    };
  }

  const resumed = await rpcCall(transport, 2, "thread/resume", { threadId });
  if (!resumed?.result?.thread) {
    return {
      status: "failed",
      reason: "thread-resume-failed",
      detail: resumed?.error?.message ?? null,
    };
  }

  const readBeforeStart = await rpcCall(transport, 3, "thread/read", {
    threadId,
    includeTurns: true,
  });
  if (!readBeforeStart?.result?.thread) {
    return {
      status: "failed",
      reason: "thread-read-before-start-failed",
      detail: readBeforeStart?.error?.message ?? null,
    };
  }

  const currentThread = readBeforeStart.result.thread;
  const currentStatus = getThreadStatusType(currentThread);
  if (currentStatus === "active") {
    return steerActiveCodexTurn({
      transport,
      threadId,
      prompt,
      currentThread,
    });
  }

  return startIdleCodexTurn({
    transport,
    threadId,
    prompt,
    cwd: input.cwd ?? null,
  });
}
