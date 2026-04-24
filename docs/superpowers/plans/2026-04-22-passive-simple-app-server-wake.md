# Passive Simple App-Server Wake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded `passive-simple` wake path that keeps the current Telegram flow and hook-based `await-reply`, but lets `passive` attempt a best-effort wake through Codex app-server before falling back to the existing queue.

**Architecture:** Keep `await-reply` unchanged. For `passive`, queue the remote prompt first, then try a minimal local app-server wake against canonical `threadId` truth. Use app-server as the source of truth for `threadId`, `threadName`, and project discovery by `cwd`; keep `sessionRef` only as the local Telegram/operator tag. In this product, Telegram is the remote lane and Loopndroll talks to the local app-server on the same machine. If wake is accepted and the thread is freshly observed as active after `turn/start`, clear the one-shot queue and send `Working on ...`; if wake is unavailable, fails, or cannot prove active thread state, preserve the queue and send the current `Received ...` acknowledgement.

**Tech Stack:** TypeScript, Bun, Electrobun, SQLite, Codex app-server JSON-RPC over stdio, Bun test.

---

## Scope Lock

- No Pi.
- No new registry, `Run`, or `PlanIntent`.
- No change to `await-reply`.
- No `sessionId` as canonical product truth in `v1`.
- `threadId` and `threadName` are the canonical thread fields in `v1`.
- `sessionRef` remains as the local operator/Telegram tag only.
- `cwd` drives project grouping in `v1`; app-server discovery is the truth seam.
- `v1` uses the local app-server on the same machine as Loopndroll.
- Telegram is the only remote lane in `v1`.
- All failures must fail closed.
- Queue remains canonical truth for `passive`.

## File Structure

- Create: `src/bun/codex-app-server-client.ts`
- Create: `src/bun/codex-app-server-client.test.ts`
- Create: `src/bun/passive-simple-wake.ts`
- Create: `src/bun/passive-simple-wake.test.ts`
- Modify: `src/bun/telegram-bridge.ts`
- Modify: `src/shared/app-rpc.ts`
- Modify: `src/bun/db/schema.ts`
- Modify: `src/bun/db/migrations.ts`
- Modify: `src/bun/loopndroll-core.ts`
- Modify: `src/bun/telegram-bridge-text.ts`
- Modify: `src/pages/home/ui.tsx`
- Reuse: `src/bun/telegram-control.ts`
- Reuse: `src/bun/telegram-control.test.ts`
- Reuse: `src/bun/managed-hook-script.test.ts`

## Nanotask Protocol

Every mutation nanotask must follow this sequence before moving on:

1. mutate one small surface only
2. run the narrowest proving command available
3. audit the changed file(s) and classify the result:
   - `implemented`
   - `code_proven`
   - `test_proven`
   - `runtime_proven`
4. inspect repo state for leakage:
   - confirm only the intended row/file scope moved
   - confirm no unrelated rows from the previous nanotask leaked into this one
5. record a checkpoint note in the plan execution log or commit message draft
6. stop and confirm the next exact nanotask before continuing

If a nanotask fails the audit, do not continue to the next one.

## Critical Early Assumptions

1. Loopndroll can reach an initialized local Codex app-server on the same machine.
2. App-server `thread/list` can discover project threads by `cwd`, and the returned records carry canonical `threadId` and `thread.name`.
3. If `threadId` is already known, wake uses that directly; otherwise discovery can recover a unique wake target by `cwd`.
4. If neither a stored `threadId` nor a unique discovery result exists, this plan fails closed and `passive` remains queued in `v1`.

## Realignment After Nanotask 1.11

- `Nanotask 1.11` proved the old seam assumption is not good enough for `v1`.
- The problem is not just the runtime permission error on `~/.codex/sessions`; the older plan also kept the wrong product model alive by treating `session_id` and heuristic `title` as if they were canonical thread truth.
- From this point onward, the plan uses:
  - `threadId` as the canonical wake/resume identifier
  - `threadName` as the canonical visible thread name
  - `sessionRef` as the local short tag only
  - `cwd` as the project grouping seam for discovery
- The next executable work is therefore a model realignment step before any further passive wake wiring.

## Product Transport Clarification

- The earlier transport expansion was too broad for the actual product.
- For this product, each machine runs:
  - its own Loopndroll
  - its own local Codex/app-server
  - its own Telegram bot/control lane
- So the `v1` transport model is:
  - remote operator input over Telegram
  - local Loopndroll to local app-server execution
- SSH, tunnels, or remote app-server lanes are not part of the core `v1` path here.

---

### Task 1: Prove The Wake Seam Before Wiring Product Logic

**Files:**
- Create: `src/bun/codex-app-server-client.test.ts`
- Create: `src/bun/codex-app-server-client.ts`

- [ ] **Nanotask 1.1: Add the first failing handshake test**

```ts
import { describe, expect, test } from "bun:test";

import { attemptPassiveWakeViaCodexAppServer } from "./codex-app-server-client";

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
});
```

- [ ] **Nanotask 1.2: Run the single test and confirm failure**

Run: `bun test src/bun/codex-app-server-client.test.ts`

Expected: FAIL because `src/bun/codex-app-server-client.ts` does not exist yet.

- [ ] **Nanotask 1.3: Implement only the client types and the JSON-RPC call helper**

```ts
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

async function rpcCall(
  transport: CodexAppServerTransport,
  id: number,
  method: string,
  params: Record<string, unknown>,
) {
  await transport.writeMessage({ id, method, params });
  return (await transport.readMessage()) as
    | { id: number; result?: Record<string, unknown>; error?: { message?: string } }
    | undefined;
}
```

- [ ] **Nanotask 1.4: Audit 1.3 and checkpoint**

Audit target:
- `src/bun/codex-app-server-client.ts`

Required outcome:
- `implemented`
- `code_proven` for type shapes and `rpcCall`

Leakage check:
- no spawning logic yet
- no Telegram integration yet

- [ ] **Nanotask 1.5: Implement the minimal wake flow only**

```ts
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

  return {
    status: "accepted",
    threadId,
    turnId:
      typeof started.result.turn === "object" &&
      started.result.turn !== null &&
      "id" in started.result.turn &&
      typeof started.result.turn.id === "string"
        ? started.result.turn.id
        : null,
  };
}
```

- [ ] **Nanotask 1.6: Run the test and confirm pass**

Run: `bun test src/bun/codex-app-server-client.test.ts`

Expected: PASS with the first handshake test green.

- [ ] **Nanotask 1.7: Add the fail-closed resume rejection test**

```ts
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
```

- [ ] **Nanotask 1.8: Run the client test file again**

Run: `bun test src/bun/codex-app-server-client.test.ts`

Expected: PASS with 2 tests green.

- [ ] **Nanotask 1.9: Add the real spawned transport helper**

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function createSpawnedCodexAppServerTransport(): Promise<CodexAppServerTransport> {
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const sent: unknown[] = [];
  const lines: string[] = [];
  const readline = createInterface({ input: child.stdout });
  readline.on("line", (line) => lines.push(line));

  return {
    sent,
    async readMessage() {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const line = lines.shift();
        if (line) {
          return JSON.parse(line);
        }
        await Bun.sleep(25);
      }
      throw new Error("app-server-timeout");
    },
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
```

- [ ] **Nanotask 1.10: Audit 1.9 and checkpoint**

Audit target:
- `src/bun/codex-app-server-client.ts`

Required outcome:
- `implemented`
- `code_proven`
- `test_proven` for fake transport path

Leakage check:
- still no queue semantics
- still no bridge integration

- [ ] **Nanotask 1.11: Run the real seam probe**

Run:

```bash
bun test src/bun/codex-app-server-client.test.ts
```

Then do a manual probe with a known real `threadId` through the spawned transport helper.

Expected:
- if `thread/resume` works, continue
- if `thread/resume` fails for a known thread, stop the entire plan and keep `passive` queue-only in `v1`

- [ ] **Nanotask 1.12: Checkpoint commit**

```bash
git add src/bun/codex-app-server-client.ts src/bun/codex-app-server-client.test.ts
git commit -m "feat: add passive wake app-server seam probe"
```

---

### Task 1R: Canonical Thread Identity Realignment Before Product Wiring

**Files:**
- Modify: `src/shared/app-rpc.ts`
- Modify: `src/bun/db/schema.ts`
- Modify: `src/bun/db/migrations.ts`
- Modify: `src/bun/loopndroll-core.ts`
- Modify: `src/bun/telegram-bridge-text.ts`
- Modify: `src/pages/home/ui.tsx`
- Modify: `src/bun/codex-app-server-client.ts`
- Modify: `src/bun/codex-app-server-client.test.ts`

- [ ] **Nanotask 1R.1: Add the first failing canonical model test**

Create or extend the narrowest test surface that asserts the shared session model exposes canonical thread truth:

```ts
type LoopSession = {
  threadId: string;
  sessionRef: string;
  cwd: string | null;
  threadName: string | null;
};
```

The test must fail while `sessionId` or heuristic `title` still appear as canonical fields.

- [ ] **Nanotask 1R.2: Run the narrow canonical model test and confirm failure**

Run the narrowest available test command for the file touched in `1R.1`.

Expected: FAIL because the model still exposes `sessionId` and `title`.

- [ ] **Nanotask 1R.3: Change the shared contract to canonical thread fields**

Mutate only:
- `src/shared/app-rpc.ts`

Required shape:

```ts
export type LoopSession = {
  threadId: string;
  sessionRef: string;
  source: "startup" | "resume" | "stop";
  cwd: string | null;
  notificationIds: string[];
  archived: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  activeSince: string | null;
  stopCount: number;
  preset: LoopPreset | null;
  presetSource: LoopSessionPresetSource;
  effectivePreset: LoopPreset | null;
  completionCheckId: string | null;
  completionCheckWaitForReply: boolean;
  effectiveCompletionCheckId: string | null;
  effectiveCompletionCheckWaitForReply: boolean;
  threadName: string | null;
  transcriptPath: string | null;
  lastAssistantMessage: string | null;
};
```

- [ ] **Nanotask 1R.4: Run the canonical model test and confirm pass**

Run the same narrow command as `1R.2`.

Expected: PASS.

- [ ] **Nanotask 1R.5: Rename the persistence layer to thread truth**

Mutate only:
- `src/bun/db/schema.ts`
- `src/bun/db/migrations.ts`
- `src/bun/loopndroll-core.ts`

Required direction:
- `session_id` becomes `thread_id`
- `title` becomes `thread_name`
- all read/write mapping functions expose `threadId` and `threadName`
- `sessionRef` remains unchanged

If the migration strategy must preserve old rows, do it as a compatibility migration, but the runtime model after this task must speak only in `threadId`/`threadName`.

- [ ] **Nanotask 1R.6: Audit 1R.5 and checkpoint**

Audit targets:
- `src/bun/db/schema.ts`
- `src/bun/db/migrations.ts`
- `src/bun/loopndroll-core.ts`

Required outcome:
- `implemented`
- `code_proven`

Leakage check:
- no Telegram bridge wake logic touched yet
- no app-server discovery logic touched yet

- [ ] **Nanotask 1R.7: Stop using heuristic title as canonical UI truth**

Mutate only:
- `src/bun/telegram-bridge-text.ts`
- `src/pages/home/ui.tsx`

Required behavior:
- prefer `threadName`
- if `threadName` is missing, do not synthesize a fake canonical name from prompt text
- show `[project] [C#]` without a fake name when needed

- [ ] **Nanotask 1R.8: Run the narrow UI/text regression set**

Run:

```bash
bun test src/bun/telegram-control.test.ts src/bun/telegram-output.test.ts
```

Expected: PASS after the canonical naming shift.

## Remaining Tranches From Current State

Current landed state:
- canonical shared model is partially realigned
- persistence/core naming is shifted to `threadId` / `threadName`
- Telegram/UI text no longer treats heuristic title as canonical truth
- the next work starts from discovery and transport, not from renaming

The remaining work is regrouped into tranches first. Nanotasks will be regenerated after this tranche split is accepted.

### Tranche A: Local App-Server Transport Lane

Goal:
- make local app-server reachability a first-class dependency without changing product semantics

In scope:
- keep `src/bun/codex-app-server-client.ts` as the single client boundary
- support the local app-server lane used by the machine running Loopndroll
- keep the transport boundary narrow so discovery/wake logic does not leak process details everywhere
- keep transport selection fail-closed and explicit

Out of scope:
- no Telegram routing changes yet
- no passive queue mutation yet
- no wake orchestration beyond client-level primitives

Exit gate:
- there is one app-server client API surface
- the client can reach the supported local app-server lane
- process/transport details do not silently redefine canonical truth

**Files:**
- Modify: `src/bun/codex-app-server-client.ts`
- Modify: `src/bun/codex-app-server-client.test.ts`

- [ ] **Nanotask A.1: Add the first failing local transport lifecycle test**

Mutate only:
- `src/bun/codex-app-server-client.test.ts`

Add a narrow test for the local app-server transport factory that proves:
- JSONL messages are written with newline framing
- one line from stdout becomes one parsed message
- `close()` shuts down the local child process

This test must target the transport factory only, not discovery or wake orchestration.

- [ ] **Nanotask A.2: Run the narrow transport test and confirm failure**

Run:

```bash
bun test src/bun/codex-app-server-client.test.ts
```

Expected:
- FAIL because the current spawned transport helper is not yet structured for deterministic lifecycle testing

- [ ] **Nanotask A.3: Refactor the local transport factory into a testable boundary**

Mutate only:
- `src/bun/codex-app-server-client.ts`

Required direction:
- preserve `createSpawnedCodexAppServerTransport()` as the product-facing API
- introduce only the minimum internal seam needed to inject:
  - child process creation
  - line reader creation
  - timeout if needed
- do not touch discovery or wake orchestration yet

- [ ] **Nanotask A.4: Run the transport test and confirm pass**

Run:

```bash
bun test src/bun/codex-app-server-client.test.ts
```

Expected:
- PASS for the local transport lifecycle test

- [ ] **Nanotask A.5: Add the first failing fail-closed startup test**

Mutate only:
- `src/bun/codex-app-server-client.test.ts`

Add a narrow test that proves local transport creation fails closed when the spawned `codex app-server` lane cannot be established, for example:
- child process startup error
- missing stdout pipe
- immediate transport setup failure

The goal is to prove transport startup does not silently limp forward.

- [ ] **Nanotask A.6: Implement fail-closed local transport startup handling**

Mutate only:
- `src/bun/codex-app-server-client.ts`

Required behavior:
- reject startup when the local transport cannot be initialized cleanly
- clean up any partially created local process state
- keep the failure inside the transport boundary

- [ ] **Nanotask A.7: Run the full client test file**

Run:

```bash
bun test src/bun/codex-app-server-client.test.ts
```

Expected:
- PASS for:
  - wake handshake tests already present
  - local transport lifecycle test
  - fail-closed startup test

- [ ] **Nanotask A.8: Audit Tranche A and checkpoint**

Audit targets:
- `src/bun/codex-app-server-client.ts`
- `src/bun/codex-app-server-client.test.ts`

Required outcome:
- `implemented`
- `code_proven`
- `test_proven`

Leakage check:
- no `thread/list` discovery yet
- no queue mutation yet
- no Telegram bridge mutation yet

### Tranche B: Discovery And Canonical Refresh

Goal:
- recover or refresh canonical thread truth from app-server before any passive wake wiring

In scope:
- add `thread/list` discovery filtered by `cwd`
- optionally use `thread/read` when inspection is needed without resuming
- return canonical:
  - `threadId`
  - `threadName`
  - `cwd`
- define bounded target resolution:
  - if stored `threadId` exists, prefer it
  - else if `thread/list` for `cwd` yields one unambiguous target, use it
  - else fail closed
- persist refreshed canonical thread metadata when discovery succeeds

Out of scope:
- no Telegram acknowledgement changes yet
- no queue deletion yet
- no heuristics to guess between multiple same-`cwd` threads

Exit gate:
- Loopndroll can recover canonical thread truth from app-server
- `cwd` is a recovery seam, not magical routing authority
- ambiguous discovery never wakes a thread

**Files:**
- Modify: `src/bun/codex-app-server-client.ts`
- Modify: `src/bun/codex-app-server-client.test.ts`
- Modify: `src/bun/loopndroll-core.ts`

- [ ] **Nanotask B.1: Add the first failing `thread/list` discovery parse test**

Mutate only:
- `src/bun/codex-app-server-client.test.ts`

Add a narrow test that proves a `thread/list` response filtered by `cwd` is parsed into canonical discovery records carrying:
- `threadId`
- `threadName`
- `cwd`

This test must target discovery parsing only, not wake orchestration.

- [ ] **Nanotask B.2: Run the narrow discovery test and confirm failure**

Run:

```bash
bun test src/bun/codex-app-server-client.test.ts
```

Expected:
- FAIL because the client does not yet expose the discovery helper

- [ ] **Nanotask B.3: Implement `thread/list` discovery parsing**

Mutate only:
- `src/bun/codex-app-server-client.ts`

Required behavior:
- add a narrow helper to call `thread/list`
- parse returned rows into canonical discovery records
- keep the result shape bounded to:
  - `threadId`
  - `threadName`
  - `cwd`
- do not add wake orchestration changes

- [ ] **Nanotask B.4: Run the discovery client test and confirm pass**

Run:

```bash
bun test src/bun/codex-app-server-client.test.ts
```

Expected:
- PASS for the new `thread/list` discovery parsing test

- [ ] **Nanotask B.5: Add the first failing canonical target resolution test**

Mutate only:
- `src/bun/codex-app-server-client.test.ts`

Add a narrow test that proves target resolution obeys this order:
- prefer stored `threadId` when present
- else use a unique discovery match from `cwd`
- else fail closed on ambiguous or missing matches

This row must not mutate Loopndroll persistence yet.

- [ ] **Nanotask B.6: Implement bounded canonical target resolution**

Mutate only:
- `src/bun/codex-app-server-client.ts`

Required behavior:
- add the minimum helper needed to resolve the canonical target
- return a bounded outcome:
  - stored `threadId`
  - unique discovery match
  - or fail-closed `null`
- do not wake the thread here

- [ ] **Nanotask B.7: Add the first failing canonical refresh merge test**

Mutate only:
- `src/bun/loopndroll-core.ts`

Add the narrowest testable surface or inline helper contract that proves:
- when discovery yields canonical truth, Loopndroll can refresh local session metadata with:
  - `threadId`
  - `threadName`
  - `cwd`
- no queue or Telegram behavior is touched

- [ ] **Nanotask B.8: Implement canonical refresh merge and run the focused discovery suite**

Mutate only:
- `src/bun/loopndroll-core.ts`
- optionally `src/bun/codex-app-server-client.test.ts` only if the refresh proof needs one extra bounded assertion

Run:

```bash
bun test src/bun/codex-app-server-client.test.ts
```

Required outcome:
- discovery parsing is green
- target resolution is green
- canonical refresh merge is code-proven in the Loopndroll core surface

Leakage check:
- no queue mutation yet
- no Telegram bridge mutation yet
- no wake execution yet

### Tranche C: Queue-First Passive Wake Coordinator

Goal:
- add the passive coordinator that sits between queued Telegram input and app-server wake

In scope:
- create `src/bun/passive-simple-wake.ts`
- keep queue-first semantics:
  - store prompt first
  - then attempt wake
- wake order:
  - resolve target `threadId`
  - `initialize`
  - `initialized`
  - `thread/resume`
  - `turn/start`
- success path:
  - clear one-shot queue
  - produce `Working on ...`
- fallback path:
  - keep queued prompt
  - produce `Received ...`

Out of scope:
- no `await-reply` changes
- no multi-thread heuristics
- no general dead-thread management semantics beyond bounded best-effort wake

Exit gate:
- passive coordinator is deterministic
- success and fallback are separately testable
- queue remains the source of truth when wake fails

**Files:**
- Create: `src/bun/passive-simple-wake.ts`
- Create: `src/bun/passive-simple-wake.test.ts`

- [ ] **Nanotask C.1: Add the first failing wake-success coordinator test**

Mutate only:
- `src/bun/passive-simple-wake.test.ts`

Add a narrow test that proves:
- a queued one-shot prompt is deleted when wake succeeds
- the returned acknowledgement is `Working on ...`

This test must target the passive coordinator only, not Telegram bridge wiring.

- [ ] **Nanotask C.2: Run the narrow wake-success test and confirm failure**

Run:

```bash
bun test src/bun/passive-simple-wake.test.ts
```

Expected:
- FAIL because the passive coordinator file does not exist yet

- [ ] **Nanotask C.3: Implement only the wake-success coordinator path**

Mutate only:
- `src/bun/passive-simple-wake.ts`

Required behavior:
- accept a queued prompt context plus a wake callback
- if wake returns `accepted`:
  - delete the one-shot queued prompt
  - return `Working on ...`
- do not implement fallback semantics yet

- [ ] **Nanotask C.4: Run the wake-success coordinator test and confirm pass**

Run:

```bash
bun test src/bun/passive-simple-wake.test.ts
```

Expected:
- PASS for the wake-success case

- [ ] **Nanotask C.5: Add the first failing fallback queue-preservation test**

Mutate only:
- `src/bun/passive-simple-wake.test.ts`

Add a narrow test that proves:
- if wake fails or is unavailable
- the queued one-shot prompt remains
- the returned acknowledgement is `Received ...`

- [ ] **Nanotask C.6: Implement fallback queue-preservation semantics**

Mutate only:
- `src/bun/passive-simple-wake.ts`

Required behavior:
- if wake is not accepted:
  - keep the queued prompt
  - return `Received ...`
- still do not touch Telegram bridge wiring

- [ ] **Nanotask C.7: Run the focused passive coordinator suite**

Run:

```bash
bun test src/bun/passive-simple-wake.test.ts src/bun/telegram-control.test.ts
```

Expected:
- PASS for:
  - wake-success coordinator path
  - fallback queue-preservation path
  - acknowledgement text compatibility

- [ ] **Nanotask C.8: Audit Tranche C and checkpoint**

Audit targets:
- `src/bun/passive-simple-wake.ts`
- `src/bun/passive-simple-wake.test.ts`

Required outcome:
- `implemented`
- `code_proven`
- `test_proven`

Leakage check:
- no Telegram bridge mutation yet
- no `await-reply` mutation yet
- no runtime proof yet

### Tranche D: Telegram Bridge Integration

Goal:
- wire passive wake into the existing Telegram bridge without touching the live hook continuation path

In scope:
- integrate passive helper into:
  - `/reply`
  - reply-to delivery
- keep `await-reply` path unchanged
- keep `sessionRef` as the operator-facing shorthand in labels
- keep project labeling derived from canonical `cwd`

Out of scope:
- no new command grammar
- no Pi
- no new registry
- no approval-system redesign

Exit gate:
- passive replies use the new queue-first wake coordinator
- `await-reply` still belongs to the hook path only
- Telegram messaging says `Working on ...` only on real accepted wake

- [ ] **Nanotask D.1: Add the first failing `/reply` passive wake-success bridge test**

Mutate only:
- create `src/bun/telegram-bridge-passive.test.ts`

Add a narrow test that proves:
- `/reply C22 ...` on a `passive` chat still queues first
- the bridge then uses the passive coordinator
- accepted wake returns `Working on ...`

Do not cover reply-to delivery yet.
Do not touch `await-reply` behavior.

- [ ] **Nanotask D.2: Run the narrow `/reply` passive bridge test and confirm failure**

Run:

```bash
bun test src/bun/telegram-bridge-passive.test.ts
```

Expected:
- FAIL because the Telegram bridge does not use the passive coordinator yet

- [ ] **Nanotask D.3: Integrate the passive coordinator into the `/reply` passive path only**

Mutate only:
- `src/bun/telegram-bridge.ts`

Required behavior:
- `/reply` on `passive` still queues first
- then attempts wake through `tryPassiveSimpleWake(...)`
- sends `Working on ...` only on accepted wake
- keeps `await-reply` logic unchanged

Do not wire reply-to delivery yet.

- [ ] **Nanotask D.4: Run the `/reply` passive bridge test and confirm pass**

Run:

```bash
bun test src/bun/telegram-bridge-passive.test.ts
```

Expected:
- PASS for the `/reply` passive wake-success case

- [ ] **Nanotask D.5: Add the first failing reply-to passive fallback-preservation test**

Mutate only:
- `src/bun/telegram-bridge-passive.test.ts`

Add a narrow test that proves:
- replying directly to a Telegram notification for a `passive` chat still queues first
- unavailable wake preserves the queued prompt
- the bridge returns `Received ...`

Do not change `await-reply` reply-to behavior in this row.

- [ ] **Nanotask D.6: Integrate the passive coordinator into reply-to passive delivery only**

Mutate only:
- `src/bun/telegram-bridge.ts`

Required behavior:
- reply-to delivery on `passive` uses the passive coordinator
- unavailable wake preserves queue and returns `Received ...`
- `await-reply` reply-to path remains unchanged

- [ ] **Nanotask D.7: Run the focused Telegram passive bridge suite**

Run:

```bash
bun test src/bun/telegram-bridge-passive.test.ts src/bun/passive-simple-wake.test.ts src/bun/telegram-control.test.ts
```

Expected:
- PASS for:
  - `/reply` passive wake-success path
  - reply-to passive fallback-preservation path
  - passive coordinator compatibility
  - acknowledgement text compatibility

- [ ] **Nanotask D.8: Audit Tranche D and checkpoint**

Audit targets:
- `src/bun/telegram-bridge.ts`
- `src/bun/telegram-bridge-passive.test.ts`

Required outcome:
- `implemented`
- `code_proven`
- `test_proven`

Leakage check:
- no `await-reply` mutation
- no runtime proof yet
- no later Tranche E transport-hardening claims yet

### Tranche E: Runtime Proof And Transport Hardening

Goal:
- prove the supported path honestly on the real runtime lane

In scope:
- static checks
- focused Bun tests
- runtime proof for:
  - unchanged `await-reply`
  - passive wake success
  - passive fail-closed fallback
- prove the local app-server lane in the real setup

Out of scope:
- no inflated `end_to_end_proven` claims from narrow local proofs alone
- no closure claim if runtime truth still depends on unresolved ambiguity

Exit gate:
- strongest safe proof includes runtime evidence for success and fallback
- no fake blocker remains around the local app-server seam
- wording is cut to the strongest safe truth only

- [ ] **Nanotask E.1: Add the first failing local app-server runtime smoke probe**

Mutate only:
- create `scripts/passive_simple_runtime_probe.ts`

Add a narrow runtime probe that can:
- connect to the local `codex app-server`
- run `initialize`
- run `thread/list` for a provided `cwd`
- print a bounded JSON result for operator inspection

Do not probe Telegram bridge behavior yet.
Do not probe `await-reply` yet.

- [ ] **Nanotask E.2: Run the local app-server smoke probe and confirm the true lane state**

Run:

```bash
bun run scripts/passive_simple_runtime_probe.ts --mode smoke --cwd <project-cwd>
```

Expected:
- either prove the local app-server lane is reachable
- or capture the true blocking runtime defect without inflating closure

- [ ] **Nanotask E.3: Extend the runtime probe for passive success and fallback scenarios**

Mutate only:
- `scripts/passive_simple_runtime_probe.ts`

Required behavior:
- add a bounded passive success probe against a concrete thread target
- add a bounded passive fallback probe against an unavailable or invalid thread target
- keep output JSON and operator-readable

Do not mutate Telegram bridge product code in this row.

- [ ] **Nanotask E.4: Run the passive success runtime probe**

Run:

```bash
bun run scripts/passive_simple_runtime_probe.ts --mode passive-success --thread-id <thread-id> --cwd <project-cwd> --prompt "<prompt>"
```

Expected:
- either prove real accepted wake on the local app-server lane
- or capture the true success-path blocker

- [ ] **Nanotask E.5: Add the first failing `await-reply` unchanged runtime guard test**

Mutate only:
- create `src/bun/telegram-bridge-runtime-guard.test.ts`

Add a narrow guard test that proves:
- the passive bridge changes did not alter the existing `await-reply` freeform or `/reply` behavior

Do not add new passive behavior in this row.

- [ ] **Nanotask E.6: Run the `await-reply` unchanged guard test**

Run:

```bash
bun test src/bun/telegram-bridge-runtime-guard.test.ts
```

Expected:
- PASS for unchanged `await-reply` behavior

- [ ] **Nanotask E.7: Run the passive fallback runtime probe and capture fail-closed truth**

Run:

```bash
bun run scripts/passive_simple_runtime_probe.ts --mode passive-fallback --thread-id <invalid-or-unavailable-thread-id> --cwd <project-cwd> --prompt "<prompt>"
```

Expected:
- either prove real fail-closed fallback on the local app-server lane
- or capture the true fallback-path blocker

- [ ] **Nanotask E.8: Audit Tranche E and checkpoint**

Audit targets:
- `scripts/passive_simple_runtime_probe.ts`
- `src/bun/telegram-bridge-runtime-guard.test.ts`
- runtime proof outputs captured in the checkpoint

Required outcome:
- `implemented`
- `code_proven`
- `test_proven`
- `runtime_proven` only for the exact runtime claims actually observed

Leakage check:
- no inflated `end_to_end_proven` claim
- no installer/product proof leakage
- no closure claim if the real runtime lane still contradicts the expected path

---

### Tranche F: Product Setup Surface And Static Check Proof

Goal:
- prove the product-facing setup surface honestly without inflating installer or release closure

In scope:
- focused product setup proof for:
  - `ensureLoopndrollSetup`
  - `getLoopndrollState`
  - hook registration health visibility
  - runtime-state visibility on the product snapshot
- repo static checks through the supported `pnpm run check` command
- focused RPC exposure proof for the setup surface

Out of scope:
- no macOS signing, notarization, or release publishing proof
- no GitHub release upload proof
- no auto-update distribution proof
- no inflated installer-ready or ship-ready claim

Exit gate:
- strongest safe proof includes:
  - product-facing setup snapshot proof
  - static-check truth
  - RPC surface proof for setup handlers
- wording stays bounded to what the product/setup surface actually proves

- [ ] **Nanotask F.1: Add the first failing product setup snapshot test**

Mutate only:
- create `src/bun/hook-management-product.test.ts`

Add a narrow test that proves:
- `ensureLoopndrollSetup()` returns a product-facing snapshot with:
  - `runtimeState`
  - `hooksAutoRegistration`
  - `health.registered`
  - `health.issues`

Do not add static-check proof in this row.
Do not add installer or release semantics in this row.

- [ ] **Nanotask F.2: Run the narrow product setup snapshot test and confirm the true state**

Run:

```bash
bun test src/bun/hook-management-product.test.ts
```

Expected:
- either prove the current setup surface already supports the bounded product snapshot contract
- or capture the true local defect in the setup seam

- [ ] **Nanotask F.3: Implement the minimum product setup snapshot seam**

Mutate only:
- `src/bun/hook-management.ts`

Required behavior:
- make the setup snapshot contract testable without widening product semantics
- keep `ensureLoopndrollSetup()` and `getLoopndrollState()` as the product-facing setup entrypoints

Do not mutate Telegram bridge behavior in this row.
Do not add installer or release behavior in this row.

- [ ] **Nanotask F.4: Run the product setup snapshot test and confirm pass**

Run:

```bash
bun test src/bun/hook-management-product.test.ts
```

Expected:
- PASS for the bounded product setup snapshot contract

- [ ] **Nanotask F.5: Run the repo static checks and capture the true static state**

Run:

```bash
pnpm run check
```

Expected:
- either prove the repo static-check surface cleanly
- or capture the true blocking static defects without inflating product closure

- [ ] **Nanotask F.6: Add the first failing product RPC setup guard test**

Mutate only:
- create `src/bun/index-loopndroll-rpc.test.ts`

Add a narrow guard test that proves:
- the product RPC surface still exposes:
  - `ensureLoopndrollSetup`
  - `getLoopndrollState`

Do not add runtime or installer proof in this row.

- [ ] **Nanotask F.7: Run the focused product RPC setup guard test**

Run:

```bash
bun test src/bun/index-loopndroll-rpc.test.ts
```

Expected:
- PASS for the bounded product RPC setup exposure contract

- [ ] **Nanotask F.8: Audit Tranche F and checkpoint**

Audit targets:
- `src/bun/hook-management-product.test.ts`
- `src/bun/hook-management.ts`
- `src/bun/index-loopndroll-rpc.test.ts`
- static-check output captured in the checkpoint

Required outcome:
- `implemented`
- `code_proven`
- `test_proven`
- `runtime_proven` only for the exact product/setup claims actually observed

Leakage check:
- no installer or release proof inflation
- no end-to-end or ship-ready claim
- no later-tranche behavior leakage

---

### Tranche G: Sacrificial Static-Check Lane Proof

Objective:
- prove the repo static-check surface through a sacrificial lane instead of the host-global toolchain
- keep host-global `pnpm` and host dependency materialization out of scope
- make the static-check lane explicit, fail-closed, and operator-visible

In scope:
- bounded sacrificial-lane planning for:
  - project `cwd`
  - sandbox root selection
  - repo-local `check` command execution through the sacrificial lane only
- narrow proof for:
  - no host-global `pnpm` fallback
  - no implicit install/materialization step
  - captured `lint` / `format:check` / `typecheck` truth or explicit lane blocker

Out of scope:
- no host-global `pnpm` install
- no host dependency materialization
- no installer, release, or runtime-product proof
- no later-tranche policy expansion beyond the sacrificial static-check lane

Exit gate:
- strongest safe proof includes:
  - bounded sacrificial-lane contract proof
  - explicit fail-closed guard against host-global `pnpm` fallback
  - captured sacrificial-lane static-check truth or explicit lane blocker
- wording stays bounded to the sacrificial static-check lane only

- [ ] **Nanotask G.1: Add the first failing sacrificial static-check lane test**

Mutate only:
- create `src/bun/sacrificial-static-check.test.ts`

Add a narrow test that proves:
- the sacrificial lane plan requires:
  - `cwd`
  - `sandboxRoot`
  - repo `check` execution through the sacrificial lane only
- the lane plan rejects host-global `pnpm` fallback

Do not run the sacrificial lane in this row.
Do not add installer or release semantics in this row.

- [ ] **Nanotask G.2: Run the narrow sacrificial static-check lane test and confirm the true state**

Run:

```bash
bun test src/bun/sacrificial-static-check.test.ts
```

Expected:
- either prove the current repo already exposes the bounded sacrificial-lane contract
- or capture the true local defect in the lane seam

- [ ] **Nanotask G.3: Implement the minimum sacrificial static-check lane seam**

Mutate only:
- create `src/bun/sacrificial-static-check.ts`

Required behavior:
- build a bounded sacrificial static-check execution plan
- require explicit `cwd` and `sandboxRoot`
- reject host-global `pnpm` fallback
- keep install/materialization out of scope

Do not execute the lane in this row.
Do not mutate product/runtime behavior in this row.

- [ ] **Nanotask G.4: Run the sacrificial static-check lane test and confirm pass**

Run:

```bash
bun test src/bun/sacrificial-static-check.test.ts
```

Expected:
- PASS for the bounded sacrificial static-check lane contract

- [ ] **Nanotask G.5: Add the first failing sacrificial static-check probe**

Mutate only:
- create `scripts/sacrificial_static_check_probe.ts`

Add a bounded probe that:
- accepts:
  - `--cwd <project-cwd>`
  - `--sandbox-root <sandbox-root>`
- emits bounded JSON only
- uses the sacrificial lane seam without performing install/materialization

Do not run repo static checks in this row.
Do not add runtime or installer proof in this row.

- [ ] **Nanotask G.6: Run the sacrificial static-check probe and capture lane readiness truth**

Run:

```bash
bun run scripts/sacrificial_static_check_probe.ts --cwd /Users/vitorcepedalopes/Documents/00_TheAngryPitCode_Codex/APPS_Pit/loopndroll-threadmark --sandbox-root /Users/vitorcepedalopes/TheAngryPitCode/sandbox
```

Expected:
- either prove the sacrificial lane is ready for bounded static-check execution
- or capture the true fail-closed lane blocker without widening scope

- [ ] **Nanotask G.7: Run the sacrificial repo static checks and capture the true static state**

Run:

```bash
bun run scripts/sacrificial_static_check_probe.ts --cwd /Users/vitorcepedalopes/Documents/00_TheAngryPitCode_Codex/APPS_Pit/loopndroll-threadmark --sandbox-root /Users/vitorcepedalopes/TheAngryPitCode/sandbox --mode run-check
```

Expected:
- either capture clean sacrificial static-check truth for:
  - `lint`
  - `format:check`
  - `typecheck`
- or capture the true bounded blocker inside the sacrificial lane

- [ ] **Nanotask G.8: Audit Tranche G and checkpoint**

Audit targets:
- `src/bun/sacrificial-static-check.test.ts`
- `src/bun/sacrificial-static-check.ts`
- `scripts/sacrificial_static_check_probe.ts`
- sacrificial static-check output captured in the checkpoint

Required outcome:
- `implemented`
- `code_proven`
- `test_proven`
- `runtime_proven` only for the exact sacrificial-lane claims actually observed

Leakage check:
- no host-global install approval inflation
- no dependency materialization inflation
- no installer/product/runtime proof leakage
- no later-tranche behavior leakage

---

### Tranche H: Sacrificial Workspace Projection Proof

Objective:
- prove a bounded way to project this repo into the sacrificial sandbox workspace
- keep host-global `pnpm` and sandbox-side install/materialization out of scope
- make the workspace projection explicit, fail-closed, and operator-visible

In scope:
- bounded workspace-projection planning for:
  - project `cwd`
  - sandbox root selection
  - derived sandbox workspace target path
  - static-check execution only after projection into the sacrificial lane
- narrow proof for:
  - no host-global `pnpm` fallback
  - no sandbox-side install/materialization step
  - captured projection readiness and projected-lane static-check truth or explicit blocker

Out of scope:
- no host-global `pnpm` install
- no sandbox-side dependency materialization
- no installer, release, or runtime-product proof
- no later-tranche policy expansion beyond workspace projection into the sacrificial lane

Exit gate:
- strongest safe proof includes:
  - bounded workspace-projection contract proof
  - explicit fail-closed projection readiness
  - captured projected-lane static-check truth or explicit blocker
- wording stays bounded to the sacrificial workspace-projection lane only

- [ ] **Nanotask H.1: Add the first failing sacrificial workspace projection test**

Mutate only:
- create `src/bun/sacrificial-workspace-projection.test.ts`

Add a narrow test that proves:
- the projection plan requires:
  - `cwd`
  - `sandboxRoot`
  - derived sandbox `workspacePath`
- the projection plan rejects:
  - host-global `pnpm` fallback
  - sandbox-side install/materialization

Do not run the projection or static checks in this row.
Do not add installer or release semantics in this row.

- [ ] **Nanotask H.2: Run the narrow sacrificial workspace projection test and confirm the true state**

Run:

```bash
bun test src/bun/sacrificial-workspace-projection.test.ts
```

Expected:
- either prove the current repo already exposes the bounded projection contract
- or capture the true local defect in the projection seam

- [ ] **Nanotask H.3: Implement the minimum sacrificial workspace projection seam**

Mutate only:
- create `src/bun/sacrificial-workspace-projection.ts`

Required behavior:
- build a bounded sacrificial workspace projection plan
- require explicit `cwd` and `sandboxRoot`
- derive a deterministic sandbox `workspacePath`
- reject host-global `pnpm` fallback
- keep sandbox-side install/materialization out of scope

Do not execute projection in this row.
Do not mutate product/runtime behavior in this row.

- [ ] **Nanotask H.4: Run the sacrificial workspace projection test and confirm pass**

Run:

```bash
bun test src/bun/sacrificial-workspace-projection.test.ts
```

Expected:
- PASS for the bounded sacrificial workspace projection contract

- [ ] **Nanotask H.5: Add the first failing sacrificial workspace projection probe**

Mutate only:
- create `scripts/sacrificial_workspace_projection_probe.ts`

Add a bounded probe that:
- accepts:
  - `--cwd <project-cwd>`
  - `--sandbox-root <sandbox-root>`
- emits bounded JSON only
- uses the workspace-projection seam without performing install/materialization

Do not run projected static checks in this row.
Do not add runtime or installer proof in this row.

- [ ] **Nanotask H.6: Run the sacrificial workspace projection probe and capture projection readiness truth**

Run:

```bash
bun run scripts/sacrificial_workspace_projection_probe.ts --cwd /Users/vitorcepedalopes/Documents/00_TheAngryPitCode_Codex/APPS_Pit/loopndroll-threadmark --sandbox-root /Users/vitorcepedalopes/TheAngryPitCode/sandbox
```

Expected:
- either prove the workspace projection lane is ready
- or capture the true fail-closed projection blocker without widening scope

- [ ] **Nanotask H.7: Run the projected sacrificial repo static checks and capture the true static state**

Run:

```bash
bun run scripts/sacrificial_workspace_projection_probe.ts --cwd /Users/vitorcepedalopes/Documents/00_TheAngryPitCode_Codex/APPS_Pit/loopndroll-threadmark --sandbox-root /Users/vitorcepedalopes/TheAngryPitCode/sandbox --mode run-check
```

Expected:
- either capture clean projected sacrificial static-check truth for:
  - `lint`
  - `format:check`
  - `typecheck`
- or capture the true bounded blocker inside the projected sacrificial lane

- [ ] **Nanotask H.8: Audit Tranche H and checkpoint**

Audit targets:
- `src/bun/sacrificial-workspace-projection.test.ts`
- `src/bun/sacrificial-workspace-projection.ts`
- `scripts/sacrificial_workspace_projection_probe.ts`
- projected sacrificial static-check output captured in the checkpoint

Required outcome:
- `implemented`
- `code_proven`
- `test_proven`
- `runtime_proven` only for the exact projection-lane claims actually observed

Leakage check:
- no host-global install approval inflation
- no sandbox-side dependency materialization inflation
- no installer/product/runtime proof leakage
- no later-tranche behavior leakage

### Tranche I: Local Product V1 Proof Closure

**Goal:** Convert the current materially-working local product state into an honest `full product v1 working locally` claim, or expose the next real blocker without adding release/signing/notarization scope.

**Closure bar:**
- latest source changes pass full repo static checks
- latest source changes pass the full Bun test suite
- renderer build completes from the supported local toolchain path
- Electrobun desktop build completes from the fresh renderer output
- local desktop bundle launches and reaches a product snapshot
- product snapshot does not expose hidden orphan/thread-name artifacts
- runtime proof remains bounded to local product v1 and does not claim release distribution

**Scope lock:**
- no GitHub release
- no signing
- no notarization
- no updater/feed publishing
- no installer packaging beyond local Electrobun build
- no new product feature work unless a proof row exposes a concrete local defect

- [ ] **Nanotask I.1: Run full repo static checks after the latest product-prune changes**

Run:
- `node_modules/.bin/oxlint src electrobun.config.ts vite.config.ts --deny-warnings`
- `node_modules/.bin/oxfmt --check src electrobun.config.ts vite.config.ts`
- `node_modules/.bin/tsgo --noEmit -p tsconfig.json`

Required outcome:
- capture true pass/fail state
- if a check exposes a local defect inside the latest product-prune slice, apply the minimum fix and rerun only the failed check first
- do not widen into release or installer work

- [ ] **Nanotask I.2: Run the full Bun test suite**

Run:
- `bun test`

Required outcome:
- capture true pass/fail state for the current repo
- if a test exposes a local defect inside current product v1 behavior, apply the minimum fix and rerun the focused failing file before rerunning full suite

- [ ] **Nanotask I.3: Run renderer build proof**

Run first:
- `node_modules/.bin/vite build`

If host-Node Vite hangs or fails due to the already-known host toolchain path, record that explicitly and run:
- `bun ./node_modules/vite/bin/vite.js build`

Required outcome:
- capture true renderer build state
- do not treat host-toolchain setup noise as product defect unless the Bun-hosted supported path also fails

- [ ] **Nanotask I.4: Run Electrobun desktop build proof**

Run:
- `./node_modules/.bin/electrobun build`

Required outcome:
- capture true local desktop build state
- no signing, notarization, release, or updater proof claims

- [ ] **Nanotask I.5: Launch the local desktop bundle and capture setup snapshot truth**

Run the local unsigned bundle:
- `open build/dev-macos-arm64/Loopndroll-dev.app`

Capture:
- process starts and remains alive long enough for setup
- `ensureLoopndrollSetup()` snapshot contains the expected visible sessions
- no hidden internal thread-name artifact appears in the supported snapshot

Required outcome:
- `runtime_proven` only for the local unsigned desktop bundle

- [ ] **Nanotask I.6: Run the local passive runtime smoke probe after the fresh build**

Run:
- `bun run scripts/passive_simple_runtime_probe.ts --cwd /Users/vitorcepedalopes/Documents/00_TheAngryPitCode_Codex/APPS_Pit/loopndroll-threadmark`

Required outcome:
- capture whether local app-server discovery and passive runtime smoke still pass after the latest changes
- no Telegram live-token proof unless separately authorized

- [ ] **Nanotask I.7: Audit local product v1 proof and classify remaining debt**

Audit:
- static proof
- test proof
- renderer build proof
- desktop build proof
- runtime snapshot proof
- passive smoke proof

Required outcome:
- state whether `full product v1 working locally` is honestly reached
- explicitly separate remaining debt into:
  - release/deployment debt
  - product-proof debt
  - environment/toolchain debt

- [ ] **Nanotask I.8: Checkpoint Tranche I and update progress**

Update:
- `docs/status/progress.md`
- this checkpoint log

Required outcome:
- checkpoint the strongest safe truth
- do not claim shipped/released unless release distribution proof exists

---

## Exit Criteria

- `await-reply` remains unchanged
- runtime and product model use canonical `threadId` and `threadName`
- `sessionRef` remains local-only shorthand
- project grouping comes from `cwd`
- app-server transport is local to the machine running Loopndroll
- `passive` attempts best-effort wake via app-server
- target resolution uses stored `threadId` first, then unique `cwd` discovery, else fails closed
- wake success produces `Working on ...` only after a fresh active thread observation
- wake failure preserves queue and produces `Received ...`
- no Pi, registry, or rework semantics leaked into `v1`
- static checks pass
- product-facing setup snapshot stays explicit about hook registration health and runtime state
- focused Bun tests pass
- runtime proof covers both success and fallback
