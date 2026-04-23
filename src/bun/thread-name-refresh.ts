import { readFile } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import type { LoopSession } from "../shared/app-rpc";
import {
  createSpawnedCodexAppServerTransport,
  listThreadsForCwdViaCodexAppServer,
  type CanonicalThreadDiscoveryRecord,
} from "./codex-app-server-client";
import { looksStaleStoredThreadName } from "./thread-name-artifact";
import { deriveThreadNameFromTranscript } from "./thread-name-transcript";

type ThreadNameRefreshCandidate = Pick<
  LoopSession,
  "threadId" | "cwd" | "threadName" | "transcriptPath"
>;

type ThreadNameRefreshUpdate = {
  threadId: string;
  threadName: string;
};

function normalizeThreadName(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCwd(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function readTranscriptSessionMetaCwd(transcriptPath: string | null | undefined) {
  const normalizedTranscriptPath = normalizeCwd(transcriptPath);
  if (normalizedTranscriptPath === null) {
    return null;
  }

  try {
    const raw = await readFile(normalizedTranscriptPath, "utf8");
    const firstLine = raw.split("\n", 1)[0]?.trim();
    if (!firstLine) {
      return null;
    }

    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { cwd?: string | null };
    };
    if (parsed.type !== "session_meta") {
      return null;
    }

    return normalizeCwd(parsed.payload?.cwd);
  } catch {
    return null;
  }
}

async function collectDiscoveryCwds(candidates: ThreadNameRefreshCandidate[]) {
  const discoveryCwds = new Set<string>();

  for (const candidate of candidates) {
    const storedCwd = normalizeCwd(candidate.cwd);
    if (storedCwd !== null) {
      discoveryCwds.add(storedCwd);
    }

    const transcriptCwd = await readTranscriptSessionMetaCwd(candidate.transcriptPath);
    if (transcriptCwd !== null) {
      discoveryCwds.add(transcriptCwd);
    }
  }

  return [...discoveryCwds];
}

export function collectCanonicalThreadNameUpdates(
  candidates: ThreadNameRefreshCandidate[],
  discoveredThreads: CanonicalThreadDiscoveryRecord[],
) {
  const discoveredByThreadId = new Map(
    discoveredThreads.map((thread) => [thread.threadId, normalizeThreadName(thread.threadName)]),
  );

  const updates: ThreadNameRefreshUpdate[] = [];

  for (const candidate of candidates) {
    const nextThreadName = discoveredByThreadId.get(candidate.threadId) ?? null;
    const currentThreadName = normalizeThreadName(candidate.threadName);

    if (nextThreadName === null || nextThreadName === currentThreadName) {
      continue;
    }

    updates.push({
      threadId: candidate.threadId,
      threadName: nextThreadName,
    });
  }

  return updates;
}

async function collectTranscriptThreadNameUpdates(
  candidates: ThreadNameRefreshCandidate[],
  canonicalUpdates: ThreadNameRefreshUpdate[],
) {
  const canonicalUpdatedThreadIds = new Set(canonicalUpdates.map((update) => update.threadId));
  const updates: ThreadNameRefreshUpdate[] = [];

  for (const candidate of candidates) {
    if (canonicalUpdatedThreadIds.has(candidate.threadId)) {
      continue;
    }

    if (!looksStaleStoredThreadName(candidate.threadName)) {
      continue;
    }

    const derivedThreadName = await deriveThreadNameFromTranscript(candidate.transcriptPath);
    const currentThreadName = normalizeThreadName(candidate.threadName);

    if (derivedThreadName === null || derivedThreadName === currentThreadName) {
      continue;
    }

    updates.push({
      threadId: candidate.threadId,
      threadName: derivedThreadName,
    });
  }

  return updates;
}

export async function refreshCanonicalThreadNames(
  db: Database,
  listThreadsForCwd = async (cwd: string) => {
    const transport = await createSpawnedCodexAppServerTransport();
    try {
      return await listThreadsForCwdViaCodexAppServer(transport, cwd);
    } finally {
      await transport.close();
    }
  },
) {
  const candidates = db
    .query(
      `select
      thread_id as threadId,
      cwd,
      thread_name as threadName,
      transcript_path as transcriptPath
    from sessions`,
    )
    .all() as ThreadNameRefreshCandidate[];

  const discoveryCwds = await collectDiscoveryCwds(candidates);
  const discoveredThreads: CanonicalThreadDiscoveryRecord[] = [];

  for (const cwd of discoveryCwds) {
    discoveredThreads.push(...(await listThreadsForCwd(cwd)));
  }

  const canonicalUpdates = collectCanonicalThreadNameUpdates(candidates, discoveredThreads);
  const transcriptUpdates = await collectTranscriptThreadNameUpdates(candidates, canonicalUpdates);
  const updates = [...canonicalUpdates, ...transcriptUpdates];

  for (const update of updates) {
    db.query("update sessions set thread_name = ? where thread_id = ?").run(
      update.threadName,
      update.threadId,
    );
  }

  return updates.length;
}
