import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateProviderDiscoveryCache,
  loadProviderDiscovery,
  peekProviderDiscoveryCache,
  providerDiscoveryTimedOut,
} from "./provider-discovery-cache";

test("loadProviderDiscovery shares one inflight request and caches the result", async () => {
  invalidateProviderDiscoveryCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({
      providers: [{ id: "codex-cli", installed: true }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([
      loadProviderDiscovery(),
      loadProviderDiscovery(),
    ]);
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
    return new Response(JSON.stringify({
      providers: [{ id: "codex-cli", installed: true }],
    }), { status: 200 });
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
