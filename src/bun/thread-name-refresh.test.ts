import { describe, expect, test } from "bun:test";
import { collectCanonicalThreadNameUpdates } from "./thread-name-refresh";

describe("collectCanonicalThreadNameUpdates", () => {
  test("refreshes stale stored names from canonical discovery results", () => {
    const updates = collectCanonicalThreadNameUpdates(
      [
        {
          threadId: "thr_stale",
          cwd: "/tmp/project",
          threadName: "sera que já está?",
          transcriptPath: null,
        },
        {
          threadId: "thr_ok",
          cwd: "/tmp/project",
          threadName: "Correct thread name",
          transcriptPath: null,
        },
        {
          threadId: "thr_missing",
          cwd: "/tmp/project",
          threadName: null,
          transcriptPath: null,
        },
      ],
      [
        {
          threadId: "thr_stale",
          threadName: "Canonical thread name",
          cwd: "/tmp/project",
        },
        {
          threadId: "thr_ok",
          threadName: "Correct thread name",
          cwd: "/tmp/project",
        },
        {
          threadId: "thr_missing",
          threadName: "Recovered title",
          cwd: "/tmp/project",
        },
      ],
    );

    expect(updates).toEqual([
      {
        threadId: "thr_stale",
        threadName: "Canonical thread name",
      },
      {
        threadId: "thr_missing",
        threadName: "Recovered title",
      },
    ]);
  });

  test("ignores empty or unchanged canonical names", () => {
    const updates = collectCanonicalThreadNameUpdates(
      [
        {
          threadId: "thr_same",
          cwd: "/tmp/project",
          threadName: "Already right",
          transcriptPath: null,
        },
        {
          threadId: "thr_empty",
          cwd: "/tmp/project",
          threadName: "Keep this",
          transcriptPath: null,
        },
      ],
      [
        {
          threadId: "thr_same",
          threadName: " Already right ",
          cwd: "/tmp/project",
        },
        {
          threadId: "thr_empty",
          threadName: "   ",
          cwd: "/tmp/project",
        },
      ],
    );

    expect(updates).toEqual([]);
  });
});
