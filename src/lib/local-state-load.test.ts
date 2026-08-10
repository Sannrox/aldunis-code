import assert from "node:assert/strict";
import test from "node:test";
import {
  loadConversationHistory,
  loadFreshConversationHistory,
  loadFreshLocalStateProjection,
  loadLocalStateProjection,
} from "./local-state-load";

test("loadLocalStateProjection coalesces concurrent callers without long-cache", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(JSON.stringify({ sequence: calls }), { status: 200 });
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([loadLocalStateProjection(), loadLocalStateProjection()]);
    assert.equal(calls, 1);
    assert.deepEqual(a, { sequence: 1 });
    assert.equal(a, b);

    // After inflight settles, a later call is a new network request.
    const c = (await loadLocalStateProjection()) as { sequence: number };
    assert.equal(calls, 2);
    assert.equal(c.sequence, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadLocalStateProjection clears a failed inflight request for retry", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 500 })
      : new Response(JSON.stringify({ recovered: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(loadLocalStateProjection(), /Local state could not be loaded/);
    assert.deepEqual(await loadLocalStateProjection(), { recovered: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadFreshLocalStateProjection bypasses an older inflight snapshot", async () => {
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
    return new Response(JSON.stringify({ sequence }), { status: 200 });
  }) as typeof fetch;

  try {
    const older = loadLocalStateProjection();
    const fresh = await loadFreshLocalStateProjection();
    assert.deepEqual(fresh, { sequence: 2 });
    releaseOlder?.();
    assert.deepEqual(await older, { sequence: 1 });
    assert.equal(calls, 2);
  } finally {
    releaseOlder?.();
    globalThis.fetch = originalFetch;
  }
});

test("loadConversationHistory coalesces by thread id and posts the thread body", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    bodies.push(String(init?.body ?? ""));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ threadId: "t1", messages: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([
      loadConversationHistory("t1"),
      loadConversationHistory("t1"),
    ]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.deepEqual(JSON.parse(bodies[0]!), { threadId: "t1" });
    await loadConversationHistory("t2");
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(bodies[1]!), { threadId: "t2" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadFreshConversationHistory does not reuse an in-flight restore", async () => {
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
    return new Response(JSON.stringify({ sequence }), { status: 200 });
  }) as typeof fetch;

  try {
    const older = loadConversationHistory("thread-a");
    const fresh = await loadFreshConversationHistory("thread-a");
    assert.deepEqual(fresh, { sequence: 2 });
    releaseOlder?.();
    assert.deepEqual(await older, { sequence: 1 });
    assert.equal(calls, 2);
  } finally {
    releaseOlder?.();
    globalThis.fetch = originalFetch;
  }
});
