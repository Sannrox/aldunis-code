import type { ProviderDiscovery } from "../types";

/**
 * Shared provider discovery for dual-pane (and other multi-mount) surfaces.
 * Without this, each Conversation mounts its own POST /api/providers/discover
 * and dual-pane stress piles concurrent probes while both chips show Checking…
 */

interface ProviderDiscoveryOptions {
  timeoutMs?: number;
  root?: string;
  worktree?: string;
}

interface ProviderDiscoveryCacheEntry {
  providers: ProviderDiscovery[];
  timedOut: boolean;
}

interface ProviderDiscoveryInflightEntry {
  controller: AbortController;
  generation: number;
  promise: Promise<ProviderDiscovery[]>;
}

export const PROVIDER_DISCOVERY_CACHE_LIMIT = 32;
export const MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS = 8;
export const MAX_PENDING_PROVIDER_DISCOVERY_REQUESTS = 32;
const cached = new Map<string, ProviderDiscoveryCacheEntry>();
const inflight = new Map<string, ProviderDiscoveryInflightEntry>();
interface PendingProviderDiscoveryRequest {
  controller: AbortController;
  resolve(release: (() => void) | null): void;
  timer: ReturnType<typeof setTimeout>;
  onAbort(): void;
  cancel(): void;
}
const pendingAdmission: PendingProviderDiscoveryRequest[] = [];
let activeRequests = 0;
let cacheGeneration = 0;
const invalidationEvents = new WeakSet<Event>();

export const PROVIDER_DISCOVERY_TIMEOUT_DETAIL =
  "Provider discovery timed out. Retry the provider check.";
// The host probes Codex, ACP packages, and Shikigami in bounded phases. Keep
// the client guard above their supported sequential worst case; this is a
// dead-request recovery bound, not a competing provider deadline.
const DEFAULT_PROVIDER_DISCOVERY_TIMEOUT_MS = 30_000;

class ProviderDiscoveryAdmissionError extends Error {}

function releaseProviderDiscoverySlot(): void {
  const next = pendingAdmission.shift();
  if (!next) {
    activeRequests -= 1;
    return;
  }
  clearTimeout(next.timer);
  next.controller.signal.removeEventListener("abort", next.onAbort);
  next.resolve(releaseProviderDiscoverySlot);
}

function acquireProviderDiscoverySlot(
  controller: AbortController,
  waitMs: number,
): Promise<(() => void) | null> {
  if (activeRequests < MAX_ACTIVE_PROVIDER_DISCOVERY_REQUESTS) {
    activeRequests += 1;
    return Promise.resolve(releaseProviderDiscoverySlot);
  }
  if (waitMs <= 0) return Promise.resolve(null);
  if (pendingAdmission.length >= MAX_PENDING_PROVIDER_DISCOVERY_REQUESTS) {
    pendingAdmission.shift()?.cancel();
  }
  return new Promise((resolve) => {
    const pending = {} as PendingProviderDiscoveryRequest;
    const finish = () => {
      const index = pendingAdmission.indexOf(pending);
      if (index >= 0) pendingAdmission.splice(index, 1);
      clearTimeout(pending.timer);
      controller.signal.removeEventListener("abort", pending.onAbort);
      resolve(null);
    };
    Object.assign(pending, {
      controller,
      resolve,
      timer: setTimeout(() => finish(), waitMs),
      onAbort: () => finish(),
      cancel: finish,
    });
    controller.signal.addEventListener("abort", pending.onAbort, { once: true });
    pendingAdmission.push(pending);
  });
}

function contextKey(options: ProviderDiscoveryOptions): string {
  return JSON.stringify([options.root ?? null, options.worktree ?? null]);
}

function cachedEntry(key: string): ProviderDiscoveryCacheEntry | undefined {
  const entry = cached.get(key);
  if (!entry) return undefined;
  // Map insertion order is the LRU order. Reinsert reads at the newest edge.
  cached.delete(key);
  cached.set(key, entry);
  return entry;
}

function cacheEntry(key: string, entry: ProviderDiscoveryCacheEntry): void {
  cached.delete(key);
  cached.set(key, entry);
  while (cached.size > PROVIDER_DISCOVERY_CACHE_LIMIT) {
    const oldest = cached.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cached.delete(oldest);
  }
}

export function invalidateProviderDiscoveryCache(): void {
  cacheGeneration += 1;
  cached.clear();
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
}

/** Invalidate once when one global browser event is delivered to multiple panes. */
export function invalidateProviderDiscoveryCacheForEvent(event: Event): void {
  if (invalidationEvents.has(event)) return;
  invalidationEvents.add(event);
  invalidateProviderDiscoveryCache();
}

export function peekProviderDiscoveryCache(
  options: ProviderDiscoveryOptions = {},
): ProviderDiscovery[] | null {
  return cachedEntry(contextKey(options))?.providers ?? null;
}

export function providerDiscoveryTimedOut(options: ProviderDiscoveryOptions = {}): boolean {
  return cachedEntry(contextKey(options))?.timedOut ?? false;
}

export async function loadProviderDiscovery(
  options: ProviderDiscoveryOptions = {},
): Promise<ProviderDiscovery[]> {
  const key = contextKey(options);
  const existing = cachedEntry(key);
  if (existing) return existing.providers;
  const pending = inflight.get(key);
  if (pending) return pending.promise;
  const controller = new AbortController();
  const generation = cacheGeneration;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_DISCOVERY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const hasContext = options.root !== undefined || options.worktree !== undefined;
  const next = (async () => {
    const release = await acquireProviderDiscoverySlot(controller, timeoutMs);
    if (!release) {
      if (Date.now() < deadline && !controller.signal.aborted) {
        throw new ProviderDiscoveryAdmissionError("Provider discovery admission was superseded.");
      }
      throw new Error(PROVIDER_DISCOVERY_TIMEOUT_DETAIL);
    }
    if (controller.signal.aborted) {
      release();
      throw new Error(PROVIDER_DISCOVERY_TIMEOUT_DETAIL);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      release();
      throw new Error(PROVIDER_DISCOVERY_TIMEOUT_DETAIL);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = fetch("/api/providers/discover", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hasContext ? { root: options.root, worktree: options.worktree } : {}),
      }).then(async (response) => {
        if (!response.ok) throw new Error("Provider discovery failed.");
        const body = (await response.json()) as { providers?: ProviderDiscovery[] };
        return body.providers ?? [];
      });
      return await Promise.race([
        request,
        new Promise<ProviderDiscovery[]>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(PROVIDER_DISCOVERY_TIMEOUT_DETAIL));
            controller.abort();
          }, remainingMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      release();
    }
  })()
    .then((providers) => {
      if (cacheGeneration === generation) cacheEntry(key, { providers, timedOut: false });
      return providers;
    })
    .catch((error: unknown) => {
      // Keep Claude selectable offline. Track a timeout independently from any
      // provider so restored adapter conversations get the same recovery path.
      const fallback: ProviderDiscovery[] = [{ id: "claude-code", installed: true }];
      if (cacheGeneration === generation && !(error instanceof ProviderDiscoveryAdmissionError)) {
        cacheEntry(key, {
          providers: fallback,
          timedOut: error instanceof Error && error.message === PROVIDER_DISCOVERY_TIMEOUT_DETAIL,
        });
      }
      return fallback;
    })
    .finally(() => {
      if (inflight.get(key)?.promise === next) inflight.delete(key);
    });
  inflight.set(key, { controller, generation, promise: next });
  return next;
}
