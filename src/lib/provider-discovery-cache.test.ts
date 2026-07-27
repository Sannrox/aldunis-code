import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateProviderDiscoveryCache,
  loadProviderDiscovery,
  peekProviderDiscoveryCache,
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
