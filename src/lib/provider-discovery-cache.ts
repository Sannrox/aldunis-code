import type { ProviderDiscovery } from "../types";

/**
 * Shared provider discovery for dual-pane (and other multi-mount) surfaces.
 * Without this, each Conversation mounts its own POST /api/providers/discover
 * and dual-pane stress piles concurrent probes while both chips show Checking…
 */

let cached: ProviderDiscovery[] | null = null;
let inflight: Promise<ProviderDiscovery[]> | null = null;
let timedOut = false;

export const PROVIDER_DISCOVERY_TIMEOUT_DETAIL =
  "Provider discovery timed out. Retry the provider check.";
// The host probes Codex, ACP packages, and Shikigami in bounded phases. Keep
// the client guard above their supported sequential worst case; this is a
// dead-request recovery bound, not a competing provider deadline.
const DEFAULT_PROVIDER_DISCOVERY_TIMEOUT_MS = 30_000;

export function peekProviderDiscoveryCache(): ProviderDiscovery[] | null {
  return cached;
}

export function invalidateProviderDiscoveryCache(): void {
  cached = null;
  inflight = null;
  timedOut = false;
}

export function providerDiscoveryTimedOut(): boolean {
  return timedOut;
}

export async function loadProviderDiscovery(options: {
  timeoutMs?: number;
} = {}): Promise<ProviderDiscovery[]> {
  if (cached) return cached;
  if (inflight) return inflight;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_DISCOVERY_TIMEOUT_MS;
  const request = fetch("/api/providers/discover", {
    method: "POST",
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error("Provider discovery failed.");
    const body = await response.json() as { providers?: ProviderDiscovery[] };
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
  inflight = timedRequest
    .then((providers) => {
      timedOut = false;
      cached = providers;
      return providers;
    })
    .catch((error: unknown) => {
      // Keep Claude selectable offline. Track a timeout independently from any
      // provider so restored adapter conversations get the same recovery path.
      timedOut = error instanceof Error
        && error.message === PROVIDER_DISCOVERY_TIMEOUT_DETAIL;
      const fallback: ProviderDiscovery[] = [{ id: "claude-code", installed: true }];
      cached = fallback;
      return fallback;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
