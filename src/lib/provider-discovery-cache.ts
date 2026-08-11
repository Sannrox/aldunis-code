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

export const PROVIDER_DISCOVERY_CACHE_LIMIT = 32;
const cached = new Map<string, ProviderDiscoveryCacheEntry>();
const inflight = new Map<string, Promise<ProviderDiscovery[]>>();

export const PROVIDER_DISCOVERY_TIMEOUT_DETAIL =
  "Provider discovery timed out. Retry the provider check.";
// The host probes Codex, ACP packages, and Shikigami in bounded phases. Keep
// the client guard above their supported sequential worst case; this is a
// dead-request recovery bound, not a competing provider deadline.
const DEFAULT_PROVIDER_DISCOVERY_TIMEOUT_MS = 30_000;

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
  cached.clear();
  inflight.clear();
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
  if (pending) return pending;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_DISCOVERY_TIMEOUT_MS;
  const hasContext = options.root !== undefined || options.worktree !== undefined;
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
  const timedRequest = Promise.race([
    request,
    new Promise<ProviderDiscovery[]>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(PROVIDER_DISCOVERY_TIMEOUT_DETAIL));
        controller.abort();
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
  const next = timedRequest
    .then((providers) => {
      cacheEntry(key, { providers, timedOut: false });
      return providers;
    })
    .catch((error: unknown) => {
      // Keep Claude selectable offline. Track a timeout independently from any
      // provider so restored adapter conversations get the same recovery path.
      const fallback: ProviderDiscovery[] = [{ id: "claude-code", installed: true }];
      cacheEntry(key, {
        providers: fallback,
        timedOut: error instanceof Error && error.message === PROVIDER_DISCOVERY_TIMEOUT_DETAIL,
      });
      return fallback;
    })
    .finally(() => {
      if (inflight.get(key) === next) inflight.delete(key);
    });
  inflight.set(key, next);
  return next;
}
