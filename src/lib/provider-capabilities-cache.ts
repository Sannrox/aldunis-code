import type { ProviderCapabilities } from "../types";

/**
 * Capabilities are global (POST body is empty). Dual-pane Conversation mounts
 * each ran their own fetch; share one result across panes.
 */

let cached: ProviderCapabilities | null = null;
let inflight: Promise<ProviderCapabilities | null> | null = null;

export function peekProviderCapabilitiesCache(): ProviderCapabilities | null {
  return cached;
}

export function invalidateProviderCapabilitiesCache(): void {
  cached = null;
  inflight = null;
}

export async function loadProviderCapabilities(): Promise<ProviderCapabilities | null> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = fetch("/api/provider/capabilities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = await response.json() as ProviderCapabilities;
      cached = body;
      return body;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
