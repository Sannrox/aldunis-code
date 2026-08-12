import assert from "node:assert/strict";
import test from "node:test";
import {
  BRANCH_PR_CLIENT_BATCH_LIMIT,
  BRANCH_PR_INITIAL_REFRESH_DELAY_MS,
  BRANCH_PR_REFRESH_INTERVAL_MS,
  chunkWorktreeRoots,
  indexBranchPrResults,
  loadBranchPrLookupResults,
  prStatusAriaLabel,
  prStatusLabel,
  startBranchPrStatusPolling,
  uniqueWorktreeRoots,
} from "./branch-pr-status";
import type { BranchPrStatus } from "../types";

const sample: BranchPrStatus = {
  worktree: "/wt/a",
  branch: "codex/x",
  number: 12,
  title: "Ship feature",
  state: "open",
  url: "https://github.com/org/repo/pull/12",
};

test("pr status labels stay compact for row chrome", () => {
  assert.equal(prStatusLabel(sample), "PR #12");
  assert.equal(prStatusLabel({ ...sample, state: "merged" }), "Merged #12");
  assert.equal(prStatusLabel({ ...sample, state: "closed" }), "Closed #12");
  assert.match(prStatusAriaLabel(sample), /Ship feature/);
});

test("PR status polling pauses while hidden and refreshes immediately on return", async () => {
  let visibilityState: DocumentVisibilityState = "visible";
  let visibilityListener: (() => void) | undefined;
  let timeout: (() => void) | undefined;
  let interval: (() => void) | undefined;
  let timeoutDelay: number | undefined;
  let intervalDelay: number | undefined;
  let refreshes = 0;
  const visibility = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (_type: "visibilitychange", listener: () => void) => {
      visibilityListener = listener;
    },
    removeEventListener: (_type: "visibilitychange", listener: () => void) => {
      if (visibilityListener === listener) visibilityListener = undefined;
    },
  };
  const timers = {
    setTimeout: (callback: () => void, delay: number) => {
      timeout = callback;
      timeoutDelay = delay;
      return 1;
    },
    clearTimeout: () => {
      timeout = undefined;
    },
    setInterval: (callback: () => void, delay: number) => {
      interval = callback;
      intervalDelay = delay;
      return 2;
    },
    clearInterval: () => {
      interval = undefined;
    },
  };
  const dispose = startBranchPrStatusPolling(
    async () => {
      refreshes += 1;
    },
    visibility,
    timers,
  );

  assert.equal(refreshes, 0);
  assert.equal(timeoutDelay, BRANCH_PR_INITIAL_REFRESH_DELAY_MS);
  assert.equal(intervalDelay, BRANCH_PR_REFRESH_INTERVAL_MS);
  timeout?.();
  await Promise.resolve();
  assert.equal(refreshes, 1);

  visibilityState = "hidden";
  visibilityListener?.();
  assert.equal(timeout, undefined);
  assert.equal(interval, undefined);

  visibilityState = "visible";
  visibilityListener?.();
  await Promise.resolve();
  assert.equal(refreshes, 2);
  assert.equal(timeout, undefined);
  assert.equal(intervalDelay, BRANCH_PR_REFRESH_INTERVAL_MS);

  dispose();
  assert.equal(interval, undefined);
  assert.equal(visibilityListener, undefined);
});

test("PR status polling suppresses overlapping refresh batches", async () => {
  let release: (() => void) | undefined;
  let interval: (() => void) | undefined;
  let refreshes = 0;
  const dispose = startBranchPrStatusPolling(
    async () => {
      refreshes += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    {
      visibilityState: "visible",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    {
      setTimeout: (callback) => {
        callback();
        return 1;
      },
      clearTimeout: () => undefined,
      setInterval: (callback) => {
        interval = callback;
        return 2;
      },
      clearInterval: () => {
        interval = undefined;
      },
    },
  );

  assert.equal(refreshes, 1);
  interval?.();
  assert.equal(refreshes, 1);
  release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  interval?.();
  assert.equal(refreshes, 2);
  dispose();
});

test("PR status polling queues a visibility refresh behind an active batch", async () => {
  let visibilityState: DocumentVisibilityState = "visible";
  let visibilityListener: (() => void) | undefined;
  let release: (() => void) | undefined;
  let refreshes = 0;
  const dispose = startBranchPrStatusPolling(
    async () => {
      refreshes += 1;
      if (refreshes === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
    {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type, listener) => {
        visibilityListener = listener;
      },
      removeEventListener: (_type, listener) => {
        if (visibilityListener === listener) visibilityListener = undefined;
      },
    },
    {
      setTimeout: (callback) => {
        callback();
        return 1;
      },
      clearTimeout: () => undefined,
      setInterval: () => 2,
      clearInterval: () => undefined,
    },
  );

  assert.equal(refreshes, 1);
  visibilityState = "hidden";
  visibilityListener?.();
  visibilityState = "visible";
  visibilityListener?.();
  assert.equal(refreshes, 1);

  release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 2);
  dispose();
});

test("PR status polling aborts active work while hidden and on disposal", async () => {
  let visibilityState: DocumentVisibilityState = "visible";
  let visibilityListener: (() => void) | undefined;
  let begin: (() => void) | undefined;
  const signals: AbortSignal[] = [];
  const dispose = startBranchPrStatusPolling(
    async (signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type, listener) => {
        visibilityListener = listener;
      },
      removeEventListener: (_type, listener) => {
        if (visibilityListener === listener) visibilityListener = undefined;
      },
    },
    {
      setTimeout: (callback) => {
        begin = callback;
        return 1;
      },
      clearTimeout: () => {
        begin = undefined;
      },
      setInterval: () => 2,
      clearInterval: () => undefined,
    },
  );

  begin?.();
  assert.equal(signals.length, 1);
  visibilityState = "hidden";
  visibilityListener?.();
  assert.equal(signals[0]?.aborted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  visibilityState = "visible";
  visibilityListener?.();
  assert.equal(signals.length, 2);
  dispose();
  assert.equal(signals[1]?.aborted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 2);
});

test("cancelled PR status loading stops before the next HTTP batch", async () => {
  const controller = new AbortController();
  const requests: Array<{ body: string; signal: AbortSignal | null }> = [];
  const items = Array.from({ length: BRANCH_PR_CLIENT_BATCH_LIMIT + 1 }, (_, index) => ({
    root: "/repo",
    worktree: `/wt/${index}`,
  }));

  await assert.rejects(
    loadBranchPrLookupResults(items, controller.signal, async (_input, init) => {
      requests.push({
        body: String(init?.body),
        signal: init?.signal instanceof AbortSignal ? init.signal : null,
      });
      controller.abort();
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.signal, controller.signal);
  assert.equal(
    (JSON.parse(requests[0]?.body ?? "{}") as { items?: unknown[] }).items?.length,
    BRANCH_PR_CLIENT_BATCH_LIMIT,
  );
});

test("index and unique helpers prepare batch sidebar lookups", () => {
  const map = indexBranchPrResults([
    { worktree: "/wt/a", branch: "codex/x", pr: sample },
    { worktree: "/wt/b", branch: "main", pr: null },
  ]);
  assert.equal(map.get("/wt/a")?.number, 12);
  assert.equal(map.has("/wt/b"), false);
  assert.deepEqual(
    uniqueWorktreeRoots([
      { root: "/repo", worktree: "/wt/a" },
      { root: "/repo", worktree: "/wt/a" },
      { root: "/repo", worktree: "/wt/b" },
    ]),
    [
      { root: "/repo", worktree: "/wt/a" },
      { root: "/repo", worktree: "/wt/b" },
    ],
  );
  assert.equal(
    uniqueWorktreeRoots(
      Array.from({ length: 30 }, (_, index) => ({
        root: "/repo",
        worktree: `/wt/${index}`,
      })),
      BRANCH_PR_CLIENT_BATCH_LIMIT,
    ).length,
    BRANCH_PR_CLIENT_BATCH_LIMIT,
  );
  assert.equal(
    chunkWorktreeRoots(
      Array.from({ length: 50 }, (_, i) => i),
      24,
    ).length,
    3,
  );
});
