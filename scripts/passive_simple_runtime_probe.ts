import {
  attemptPassiveWakeViaCodexAppServer,
  createSpawnedCodexAppServerTransport,
  listThreadsForCwdViaCodexAppServer,
} from "../src/bun/codex-app-server-client";

type RuntimeProbeArgs = {
  mode: string;
  cwd: string | null;
  threadId: string | null;
  prompt: string | null;
};

function parseArgs(argv: string[]): RuntimeProbeArgs {
  let mode = "smoke";
  let cwd: string | null = null;
  let threadId: string | null = null;
  let prompt: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--mode") {
      mode = argv[index + 1] ?? mode;
      index += 1;
      continue;
    }

    if (token === "--cwd") {
      cwd = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (token === "--thread-id") {
      threadId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (token === "--prompt") {
      prompt = argv[index + 1] ?? null;
      index += 1;
    }
  }

  return { mode, cwd, threadId, prompt };
}

function printProbeOutput(payload: Record<string, unknown>) {
  console.log(JSON.stringify(payload, null, 2));
}

async function runSmokeProbe(args: RuntimeProbeArgs) {
  if (!args.cwd || args.cwd.trim().length === 0) {
    throw new Error("missing-cwd");
  }

  let transport;
  try {
    transport = await createSpawnedCodexAppServerTransport();
    const threads = await listThreadsForCwdViaCodexAppServer(transport, args.cwd);

    printProbeOutput({
      mode: "smoke",
      status: "ok",
      cwd: args.cwd,
      threadCount: threads.length,
      threads: threads.slice(0, 10),
    });
  } catch (error) {
    printProbeOutput({
      mode: "smoke",
      status: "error",
      cwd: args.cwd,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await transport?.close().catch(() => {
      // Ignore transport cleanup failures while preserving probe output.
    });
  }
}

async function runPassiveWakeProbe(args: RuntimeProbeArgs) {
  if (!args.threadId || args.threadId.trim().length === 0) {
    throw new Error("missing-thread-id");
  }
  if (!args.prompt || args.prompt.trim().length === 0) {
    throw new Error("missing-prompt");
  }

  let transport;
  try {
    transport = await createSpawnedCodexAppServerTransport();
    const result = await attemptPassiveWakeViaCodexAppServer(transport, {
      threadId: args.threadId,
      cwd: args.cwd ?? undefined,
      prompt: args.prompt,
    });

    printProbeOutput({
      mode: args.mode,
      status: "ok",
      cwd: args.cwd,
      threadId: args.threadId,
      result,
    });
  } catch (error) {
    printProbeOutput({
      mode: args.mode,
      status: "error",
      cwd: args.cwd,
      threadId: args.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await transport?.close().catch(() => {
      // Ignore transport cleanup failures while preserving probe output.
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "smoke") {
    await runSmokeProbe(args);
    return;
  }

  if (args.mode === "passive-success" || args.mode === "passive-fallback") {
    await runPassiveWakeProbe(args);
    return;
  }

  throw new Error(`unsupported-mode:${args.mode}`);
}

await main();
