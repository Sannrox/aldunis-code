import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateProviderCapabilitiesCache,
  loadProviderCapabilities,
  peekProviderCapabilitiesCache,
} from "./provider-capabilities-cache";

test("loadProviderCapabilities shares one inflight request and caches", async () => {
  invalidateProviderCapabilitiesCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return new Response(JSON.stringify({
      attachments: { maxCount: 8, maxBytes: 1 },
      commands: [],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([
      loadProviderCapabilities(),
      loadProviderCapabilities(),
    ]);
    assert.equal(calls, 1);
    assert.equal(a?.attachments.maxCount, 8);
    assert.equal(a, b);
    assert.equal(peekProviderCapabilitiesCache(), a);
    await loadProviderCapabilities();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderCapabilitiesCache();
  }
});

test("loadProviderCapabilities does not cache failed probes", async () => {
  invalidateProviderCapabilitiesCache();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return new Response(JSON.stringify({
      attachments: { maxCount: 4, maxBytes: 2 },
      commands: [],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    assert.equal(await loadProviderCapabilities(), null);
    assert.equal((await loadProviderCapabilities())?.attachments.maxCount, 4);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderCapabilitiesCache();
  }
});
