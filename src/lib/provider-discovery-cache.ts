import type { ProviderDiscovery } from "../types";

/**
 * Shared provider discovery for dual-pane (and other multi-mount) surfaces.
 * Without this, each Conversation mounts its own POST /api/providers/discover
 * and dual-pane stress piles concurrent probes while both chips show Checking…
 */

let cached: ProviderDiscovery[] | null = null;
let inflight: Promise<ProviderDiscovery[]> | null = null;

export function peekProviderDiscoveryCache(): ProviderDiscovery[] | null {
  return cached;
}

export function invalidateProviderDiscoveryCache(): void {
  cached = null;
  inflight = null;
}

export async function loadProviderDiscovery(): Promise<ProviderDiscovery[]> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetch("/api/providers/discover", { method: "POST" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Provider discovery failed.");
      const body = await response.json() as { providers?: ProviderDiscovery[] };
      const providers = body.providers ?? [];
      cached = providers;
      return providers;
    })
    .catch(() => {
      // Match previous Conversation fallback: keep Claude selectable offline.
      const fallback: ProviderDiscovery[] = [{ id: "claude-code", installed: true }];
      cached = fallback;
      return fallback;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
