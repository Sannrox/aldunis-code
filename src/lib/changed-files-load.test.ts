import assert from "node:assert/strict";
import test from "node:test";
import {
  loadChangedFiles,
  loadFreshChangedFiles,
  resetChangedFilesLoadForTests,
} from "./changed-files-load";

test("loadChangedFiles coalesces concurrent callers for the same worktree", async () => {
  resetChangedFilesLoadForTests();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { root?: string; worktree?: string };
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(
      JSON.stringify({
        files: [{ path: `${body.root}:${body.worktree}`, state: "modified" }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([
      loadChangedFiles({ root: "/repo", worktree: "/repo/wt" }),
      loadChangedFiles({ root: "/repo", worktree: "/repo/wt" }),
    ]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.equal(a[0]?.path, "/repo:/repo/wt");

    // After inflight settles, a later call is a new network request.
    const c = await loadChangedFiles({ root: "/repo", worktree: "/repo/wt" });
    assert.equal(calls, 2);
    assert.equal(c[0]?.path, "/repo:/repo/wt");
  } finally {
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});

test("loadChangedFiles keeps distinct worktrees on separate requests", async () => {
  resetChangedFilesLoadForTests();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    await Promise.all([
      loadChangedFiles({ root: "/repo", worktree: "/repo/a" }),
      loadChangedFiles({ root: "/repo", worktree: "/repo/b" }),
    ]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});

test("loadFreshChangedFiles bypasses an older inflight snapshot", async () => {
  resetChangedFilesLoadForTests();
  let calls = 0;
  let releaseOlder: (() => void) | undefined;
  const olderBlocked = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    const sequence = calls;
    if (sequence === 1) await olderBlocked;
    return new Response(
      JSON.stringify({
        files: [{ path: `seq-${sequence}`, state: "modified" }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const older = loadChangedFiles({ root: "/repo", worktree: "/repo/wt" });
    const fresh = await loadFreshChangedFiles({ root: "/repo", worktree: "/repo/wt" });
    assert.equal(fresh[0]?.path, "seq-2");
    releaseOlder?.();
    assert.equal((await older)[0]?.path, "seq-1");
    assert.equal(calls, 2);
  } finally {
    releaseOlder?.();
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});

test("loadChangedFiles surfaces host errors", async () => {
  resetChangedFilesLoadForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "git status failed" }), {
      status: 500,
    })) as typeof fetch;

  try {
    await assert.rejects(
      loadChangedFiles({ root: "/repo", worktree: "/repo/wt" }),
      /git status failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});
