import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ACTIVE_CHANGED_FILES_REQUESTS,
  loadChangedFiles,
  loadFreshChangedFiles,
  resetChangedFilesLoadForTests,
} from "./changed-files-load";

function abortableStall(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

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

test("stalled changed-file requests time out, release, and can be retried", async () => {
  resetChangedFilesLoadForTests();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) return abortableStall(init);
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const options = { root: "/repo", worktree: "/repo/stalled", timeoutMs: 5 };
    await assert.rejects(loadChangedFiles(options), /Changed files request timed out/);
    assert.deepEqual(await loadChangedFiles(options), []);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});

test("changed-file deadline remains active while consuming the response body", async () => {
  resetChangedFilesLoadForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"files":['));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    await assert.rejects(
      loadChangedFiles({ root: "/repo", worktree: "/repo/body", timeoutMs: 5 }),
      /Changed files request timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});

test("changed-file capacity rejects excess work before fetching and recovers", async () => {
  resetChangedFilesLoadForTests();
  const releases: Array<() => void> = [];
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const active = Array.from({ length: MAX_ACTIVE_CHANGED_FILES_REQUESTS }, (_, index) =>
      loadChangedFiles({ root: "/repo", worktree: `/repo/${index}` }),
    );
    await assert.rejects(
      loadChangedFiles({ root: "/repo", worktree: "/repo/excess" }),
      /Too many changed-file requests are already active/,
    );
    assert.equal(calls, MAX_ACTIVE_CHANGED_FILES_REQUESTS);
    releases.splice(0).forEach((release) => release());
    await Promise.all(active);

    const retry = loadChangedFiles({ root: "/repo", worktree: "/repo/excess" });
    assert.equal(calls, MAX_ACTIVE_CHANGED_FILES_REQUESTS + 1);
    releases.splice(0).forEach((release) => release());
    await retry;
  } finally {
    releases.splice(0).forEach((release) => release());
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});

test("fresh changed-file reads share the request capacity bound", async () => {
  resetChangedFilesLoadForTests();
  const releases: Array<() => void> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const active = Array.from({ length: MAX_ACTIVE_CHANGED_FILES_REQUESTS }, (_, index) =>
      loadFreshChangedFiles({ root: "/repo", worktree: `/repo/fresh-${index}` }),
    );
    await assert.rejects(
      loadFreshChangedFiles({ root: "/repo", worktree: "/repo/fresh-excess" }),
      /Too many changed-file requests are already active/,
    );
    releases.splice(0).forEach((release) => release());
    await Promise.all(active);
  } finally {
    releases.splice(0).forEach((release) => release());
    globalThis.fetch = originalFetch;
    resetChangedFilesLoadForTests();
  }
});
