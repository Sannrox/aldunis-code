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
    return new Response(
      JSON.stringify({
        attachments: { maxCount: 8, maxBytes: 1 },
        commands: [],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const [a, b] = await Promise.all([loadProviderCapabilities(), loadProviderCapabilities()]);
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
    return new Response(
      JSON.stringify({
        attachments: { maxCount: 4, maxBytes: 2 },
        commands: [],
      }),
      { status: 200 },
    );
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

test("loadProviderCapabilities bounds stalled fetch and response parsing", async () => {
  invalidateProviderCapabilitiesCache();
  let calls = 0;
  const signals: AbortSignal[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    signals.push(init?.signal as AbortSignal);
    if (calls === 1) return await new Promise<Response>(() => undefined);
    if (calls === 2) {
      return {
        ok: true,
        json: () => new Promise(() => undefined),
      } as Response;
    }
    return new Response(
      JSON.stringify({ attachments: { maxCount: 6, maxBytes: 3 }, commands: [] }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    assert.equal(await loadProviderCapabilities({ timeoutMs: 5 }), null);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(await loadProviderCapabilities({ timeoutMs: 5 }), null);
    assert.equal(signals[1]?.aborted, true);
    assert.equal((await loadProviderCapabilities({ timeoutMs: 20 }))?.attachments.maxCount, 6);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderCapabilitiesCache();
  }
});

test("provider capability invalidation aborts stale work without clearing its replacement", async () => {
  invalidateProviderCapabilitiesCache();
  const responses: Array<(response: Response) => void> = [];
  const signals: AbortSignal[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input, init) => {
    signals.push(init?.signal as AbortSignal);
    return new Promise<Response>((resolve) => responses.push(resolve));
  }) as typeof fetch;

  try {
    const stale = loadProviderCapabilities({ timeoutMs: 100 });
    invalidateProviderCapabilitiesCache();
    assert.equal(signals[0]?.aborted, true);
    const current = loadProviderCapabilities({ timeoutMs: 100 });
    responses[0]?.(
      new Response(JSON.stringify({ attachments: { maxCount: 1, maxBytes: 1 }, commands: [] }), {
        status: 200,
      }),
    );
    assert.equal(await stale, null);
    const sharedCurrent = loadProviderCapabilities({ timeoutMs: 100 });
    assert.equal(signals.length, 2);
    responses[1]?.(
      new Response(JSON.stringify({ attachments: { maxCount: 9, maxBytes: 9 }, commands: [] }), {
        status: 200,
      }),
    );
    const currentResult = await current;
    assert.equal(currentResult?.attachments.maxCount, 9);
    assert.equal(await sharedCurrent, currentResult);
    assert.equal(peekProviderCapabilitiesCache()?.attachments.maxCount, 9);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateProviderCapabilitiesCache();
  }
});
