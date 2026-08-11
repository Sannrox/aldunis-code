import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_INFLIGHT_HISTORY_REQUESTS,
  loadConversationHistory,
  loadFreshConversationHistory,
  loadFreshLocalStateProjection,
  loadLocalStateProjection,
} from "./local-state-load";

function abortableStall(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

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

test("loadConversationHistory sends a known sequence and maps unchanged to null", async () => {
  let body = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    body = String(init?.body ?? "");
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    assert.equal(await loadConversationHistory("thread-a", 42), null);
    assert.deepEqual(JSON.parse(body), { threadId: "thread-a", knownSequence: 42 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history coalescing does not mix callers with different known sequences", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { knownSequence: number };
    return new Response(JSON.stringify({ sequence: body.knownSequence + 1 }), { status: 200 });
  }) as typeof fetch;

  try {
    const [older, newer] = await Promise.all([
      loadConversationHistory("thread-a", 1),
      loadConversationHistory("thread-a", 2),
    ]);
    assert.equal(calls, 2);
    assert.deepEqual(older, { sequence: 2 });
    assert.deepEqual(newer, { sequence: 3 });
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

test("stalled history requests time out, release their slot, and can be retried", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) return abortableStall(init);
    return new Response(JSON.stringify({ recovered: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      loadConversationHistory("stalled", undefined, { timeoutMs: 5 }),
      /Conversation history request timed out/,
    );
    assert.deepEqual(await loadConversationHistory("stalled", undefined, { timeoutMs: 5 }), {
      recovered: true,
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history deadline remains active while the response body is consumed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"messages":['));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    await assert.rejects(
      loadConversationHistory("stalled-body", undefined, { timeoutMs: 5 }),
      /Conversation history request timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history request capacity rejects excess work before fetching and recovers", async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const active = Array.from({ length: MAX_INFLIGHT_HISTORY_REQUESTS }, (_, index) =>
      loadConversationHistory(`thread-${index}`),
    );
    await assert.rejects(
      loadConversationHistory("excess"),
      /Too many conversation history requests are already active/,
    );
    assert.equal(calls, MAX_INFLIGHT_HISTORY_REQUESTS);

    releases.splice(0).forEach((release) => release());
    await Promise.all(active);

    const retry = loadConversationHistory("excess");
    assert.equal(calls, MAX_INFLIGHT_HISTORY_REQUESTS + 1);
    releases.splice(0).forEach((release) => release());
    await retry;
  } finally {
    releases.splice(0).forEach((release) => release());
    globalThis.fetch = originalFetch;
  }
});

test("fresh history reads share the history request capacity bound", async () => {
  const releases: Array<() => void> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const active = Array.from({ length: MAX_INFLIGHT_HISTORY_REQUESTS }, (_, index) =>
      loadFreshConversationHistory(`fresh-${index}`),
    );
    await assert.rejects(
      loadFreshConversationHistory("fresh-excess"),
      /Too many conversation history requests are already active/,
    );
    releases.splice(0).forEach((release) => release());
    await Promise.all(active);
  } finally {
    releases.splice(0).forEach((release) => release());
    globalThis.fetch = originalFetch;
  }
});
