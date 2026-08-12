import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS,
  PROVIDER_DISCOVERY_CACHE_LIMIT,
  invalidateProviderDiscoveryCache,
  invalidateProviderDiscoveryCacheForEvent,
  loadProviderDiscovery,
  peekProviderDiscoveryCache,
  providerDiscoveryTimedOut,
} from "./provider-discovery-cache";

function discoveryContext(index: number) {
  return { root: "/repo", worktree: `/repo/worktree-${index}` };
}

async function settleAdmission(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("loadProviderDiscovery shares one inflight request and caches the result", async () => {
  invalidateProviderDiscoveryCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(
      JSON.stringify({
        providers: [{ id: "codex-cli", installed: true }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([loadProviderDiscovery(), loadProviderDiscovery()]);
    assert.equal(calls, 1);
    assert.deepEqual(a, [{ id: "codex-cli", installed: true }]);
    assert.equal(a, b);
    assert.deepEqual(peekProviderDiscoveryCache(), a);

    // Cache hit — no second network call.
    const c = await loadProviderDiscovery();
    assert.equal(calls, 1);
    assert.equal(c, a);

    invalidateProviderDiscoveryCache();
    assert.equal(peekProviderDiscoveryCache(), null);
    await loadProviderDiscovery();
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("loadProviderDiscovery keeps worktree-native discovery isolated", async () => {
  invalidateProviderDiscoveryCache();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = String(init?.body ?? "{}");
    requests.push(body);
    const parsed = JSON.parse(body) as { worktree?: string };
    const model = parsed.worktree?.endsWith("custom") ? "custom-model" : "native-model";
    return new Response(
      JSON.stringify({
        providers: [
          {
            id: "shikigami",
            installed: true,
            authenticated: true,
            models: [{ id: model, displayName: model, isDefault: true }],
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const first = await loadProviderDiscovery({ root: "/repo", worktree: "/repo/main" });
    const second = await loadProviderDiscovery({ root: "/repo", worktree: "/repo/custom" });
    const cachedFirst = await loadProviderDiscovery({ root: "/repo", worktree: "/repo/main" });
    assert.equal(first[0]?.models?.[0]?.id, "native-model");
    assert.equal(second[0]?.models?.[0]?.id, "custom-model");
    assert.equal(cachedFirst, first);
    assert.equal(requests.length, 2);
    assert.match(requests[0]!, /"worktree":"\/repo\/main"/);
    assert.match(requests[1]!, /"worktree":"\/repo\/custom"/);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("loadProviderDiscovery bounds a stalled request and can retry", async () => {
  invalidateProviderDiscoveryCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    return new Response(
      JSON.stringify({
        providers: [{ id: "codex-cli", installed: true }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const fallback = await loadProviderDiscovery({ timeoutMs: 5 });
    assert.deepEqual(fallback, [{ id: "claude-code", installed: true }]);
    assert.equal(providerDiscoveryTimedOut(), true);
    assert.deepEqual(peekProviderDiscoveryCache(), fallback);

    invalidateProviderDiscoveryCache();
    assert.equal(providerDiscoveryTimedOut(), false);
    const recovered = await loadProviderDiscovery({ timeoutMs: 5 });
    assert.deepEqual(recovered, [{ id: "codex-cli", installed: true }]);
    assert.equal(providerDiscoveryTimedOut(), false);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("loadProviderDiscovery keeps its bound through response parsing", async () => {
  invalidateProviderDiscoveryCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream())) as typeof fetch;

  try {
    await loadProviderDiscovery({ timeoutMs: 5 });
    assert.equal(providerDiscoveryTimedOut(), true);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery evicts the least-recently-used settled context", async () => {
  invalidateProviderDiscoveryCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { worktree: string };
    return new Response(
      JSON.stringify({
        providers: [{ id: "codex-cli", installed: true, version: body.worktree }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    for (let index = 0; index < PROVIDER_DISCOVERY_CACHE_LIMIT; index += 1) {
      await loadProviderDiscovery(discoveryContext(index));
    }
    // A read makes context zero newer than context one.
    assert.ok(peekProviderDiscoveryCache(discoveryContext(0)));
    await loadProviderDiscovery(discoveryContext(PROVIDER_DISCOVERY_CACHE_LIMIT));
    assert.ok(peekProviderDiscoveryCache(discoveryContext(0)));
    assert.equal(peekProviderDiscoveryCache(discoveryContext(1)), null);

    await loadProviderDiscovery(discoveryContext(1));
    assert.equal(calls, PROVIDER_DISCOVERY_CACHE_LIMIT + 2);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery evicts timeout state with its provider result", async () => {
  invalidateProviderDiscoveryCache();
  const originalFetch = globalThis.fetch;
  let first = true;
  globalThis.fetch = (async (_input, init) => {
    if (first) {
      first = false;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    return new Response(JSON.stringify({ providers: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const timedOutContext = discoveryContext(0);
    await loadProviderDiscovery({ ...timedOutContext, timeoutMs: 5 });
    assert.equal(providerDiscoveryTimedOut(timedOutContext), true);
    for (let index = 1; index <= PROVIDER_DISCOVERY_CACHE_LIMIT; index += 1) {
      await loadProviderDiscovery(discoveryContext(index));
    }
    assert.equal(peekProviderDiscoveryCache(timedOutContext), null);
    assert.equal(providerDiscoveryTimedOut(timedOutContext), false);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery queues distinct contexts behind its active bound", async () => {
  invalidateProviderDiscoveryCache();
  const originalFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return await new Promise<Response>((resolve) => pending.push(resolve));
  }) as typeof fetch;

  try {
    const active = Array.from({ length: MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS }, (_, index) =>
      loadProviderDiscovery(discoveryContext(index)),
    );
    const shared = loadProviderDiscovery(discoveryContext(0));
    const queuedContext = discoveryContext(MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS);
    const queued = loadProviderDiscovery(queuedContext);

    await settleAdmission();
    assert.equal(calls, MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS);
    assert.equal(peekProviderDiscoveryCache(queuedContext), null);
    pending.shift()!(new Response(JSON.stringify({ providers: [] }), { status: 200 }));
    await settleAdmission();
    assert.equal(calls, MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS + 1);
    for (const resolve of pending.splice(0)) {
      resolve(new Response(JSON.stringify({ providers: [] }), { status: 200 }));
    }
    const settled = await Promise.all([...active, shared, queued]);
    assert.equal(settled.length, MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS + 2);
    assert.equal(settled[MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS], settled[0]);
    assert.deepEqual(peekProviderDiscoveryCache(queuedContext), []);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery invalidation aborts active requests and rejects stale cache publication", async () => {
  invalidateProviderDiscoveryCache();
  await Promise.resolve();
  const originalFetch = globalThis.fetch;
  const signals: AbortSignal[] = [];
  const complete: Array<(response: Response) => void> = [];
  globalThis.fetch = (async (_input, init) => {
    signals.push(init?.signal as AbortSignal);
    return await new Promise<Response>((resolve) => complete.push(resolve));
  }) as typeof fetch;
  const context = discoveryContext(0);

  try {
    const stale = loadProviderDiscovery(context);
    await settleAdmission();
    invalidateProviderDiscoveryCache();
    assert.equal(signals[0]?.aborted, true);
    const replacement = loadProviderDiscovery(context);
    await settleAdmission();
    assert.equal(signals.length, 2);

    complete[0]!(
      new Response(JSON.stringify({ providers: [{ id: "stale", installed: true }] }), {
        status: 200,
      }),
    );
    assert.deepEqual(await stale, [{ id: "stale", installed: true }]);
    assert.equal(peekProviderDiscoveryCache(context), null);

    complete[1]!(
      new Response(JSON.stringify({ providers: [{ id: "current", installed: true }] }), {
        status: 200,
      }),
    );
    assert.deepEqual(await replacement, [{ id: "current", installed: true }]);
    assert.deepEqual(peekProviderDiscoveryCache(context), [{ id: "current", installed: true }]);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery coalesces sibling invalidation by exact event identity", async () => {
  invalidateProviderDiscoveryCache();
  await Promise.resolve();
  const originalFetch = globalThis.fetch;
  const signals: AbortSignal[] = [];
  const complete: Array<(response: Response) => void> = [];
  globalThis.fetch = (async (_input, init) => {
    signals.push(init?.signal as AbortSignal);
    return await new Promise<Response>((resolve) => complete.push(resolve));
  }) as typeof fetch;
  const context = discoveryContext(0);

  try {
    const retryEvent = new Event("aldunis:providers-retry");
    invalidateProviderDiscoveryCacheForEvent(retryEvent);
    const firstPane = loadProviderDiscovery(context);
    invalidateProviderDiscoveryCacheForEvent(retryEvent);
    const secondPane = loadProviderDiscovery(context);

    await settleAdmission();
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, false);
    complete[0]!(
      new Response(JSON.stringify({ providers: [{ id: "codex-cli", installed: true }] }), {
        status: 200,
      }),
    );
    const [first, second] = await Promise.all([firstPane, secondPane]);
    assert.equal(first, second);
    assert.deepEqual(peekProviderDiscoveryCache(context), first);
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.resolve();
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery preserves distinct synchronous invalidations", async () => {
  invalidateProviderDiscoveryCache();
  await Promise.resolve();
  const originalFetch = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = (async (_input, init) => {
    signals.push(init?.signal as AbortSignal);
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  }) as typeof fetch;
  const context = discoveryContext(0);

  try {
    invalidateProviderDiscoveryCache();
    const stale = loadProviderDiscovery(context);
    await settleAdmission();
    invalidateProviderDiscoveryCache();
    await stale;
    assert.equal(signals[0]?.aborted, true);
    assert.equal(peekProviderDiscoveryCache(context), null);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery releases slots when invalidation wins admission", async () => {
  invalidateProviderDiscoveryCache();
  await Promise.resolve();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const complete: Array<(response: Response) => void> = [];
  globalThis.fetch = (async () => {
    calls += 1;
    return await new Promise<Response>((resolve) => complete.push(resolve));
  }) as typeof fetch;

  try {
    for (let index = 0; index < MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS; index += 1) {
      const invalidated = loadProviderDiscovery(discoveryContext(index));
      invalidateProviderDiscoveryCache();
      await invalidated;
      await Promise.resolve();
    }
    const active = Array.from({ length: MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS }, (_, index) =>
      loadProviderDiscovery(discoveryContext(index + 100)),
    );
    await settleAdmission();
    assert.equal(calls, MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS);
    for (const resolve of complete) {
      resolve(new Response(JSON.stringify({ providers: [] }), { status: 200 }));
    }
    await Promise.all(active);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});

test("provider discovery does not cache a waiter displaced at queue capacity", async () => {
  invalidateProviderDiscoveryCache();
  await Promise.resolve();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  }) as typeof fetch;

  try {
    const requests = Array.from(
      { length: MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS + 33 },
      (_, index) => loadProviderDiscovery({ ...discoveryContext(index), timeoutMs: 10 }),
    );
    await Promise.all(requests);
    const displaced = discoveryContext(MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS);
    assert.equal(peekProviderDiscoveryCache(displaced), null);
    assert.equal(providerDiscoveryTimedOut(displaced), false);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderDiscoveryCache();
  }
});
