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

export type CanonicalThreadDiscoveryRecord = {
  threadId: string;
  threadName: string | null;
  cwd: string | null;
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
) {
  await transport.writeMessage({ id, method, params });
  return (await transport.readMessage()) as
    | {
        id: number;
        result?: Record<string, unknown>;
        error?: { message?: string };
      }
    | undefined;
}

export async function listThreadsForCwdViaCodexAppServer(
  transport: CodexAppServerTransport,
  cwd: string,
): Promise<CanonicalThreadDiscoveryRecord[]> {
  const trimmedCwd = cwd.trim();
  if (trimmedCwd.length === 0) {
    return [];
  }

  const init = await rpcCall(transport, 1, "initialize", {
    clientInfo: {
      name: "loopndroll",
      title: "Loopndroll",
      version: "1.1.5",
    },
  });
  if (!init?.result) {
    return [];
  }

  await transport.writeMessage({ method: "initialized", params: {} });

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

  const init = await rpcCall(transport, 1, "initialize", {
    clientInfo: {
      name: "loopndroll",
      title: "Loopndroll",
      version: "1.1.5",
    },
  });
  if (!init?.result) {
    return {
      status: "unavailable",
      reason: init?.error?.message ?? "initialize-failed",
    };
  }

  await transport.writeMessage({ method: "initialized", params: {} });

  const resumed = await rpcCall(transport, 2, "thread/resume", { threadId });
  if (!resumed?.result?.thread) {
    return {
      status: "failed",
      reason: "thread-resume-failed",
      detail: resumed?.error?.message ?? null,
    };
  }

  const started = await rpcCall(transport, 3, "turn/start", {
    threadId,
    cwd: input.cwd ?? undefined,
    input: [{ type: "text", text: prompt }],
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

  return {
    status: "accepted",
    threadId,
    turnId,
  };
}
