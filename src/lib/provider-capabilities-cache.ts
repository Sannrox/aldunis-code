import type { ProviderCapabilities } from "../types";

/**
 * Capabilities are global (POST body is empty). Dual-pane Conversation mounts
 * each ran their own fetch; share one result across panes.
 */

interface ProviderCapabilitiesInflight {
  controller: AbortController;
  promise: Promise<ProviderCapabilities | null>;
}

interface ProviderCapabilitiesLoadOptions {
  timeoutMs?: number;
}

export const PROVIDER_CAPABILITIES_TIMEOUT_MS = 30_000;
let cached: ProviderCapabilities | null = null;
let inflight: ProviderCapabilitiesInflight | null = null;
let cacheGeneration = 0;

export function peekProviderCapabilitiesCache(): ProviderCapabilities | null {
  return cached;
}

export function invalidateProviderCapabilitiesCache(): void {
  cacheGeneration += 1;
  cached = null;
  inflight?.controller.abort();
  inflight = null;
}

export async function loadProviderCapabilities(
  options: ProviderCapabilitiesLoadOptions = {},
): Promise<ProviderCapabilities | null> {
  if (cached) return cached;
  if (inflight) return inflight.promise;
  const controller = new AbortController();
  const generation = cacheGeneration;
  const timeoutMs = options.timeoutMs ?? PROVIDER_CAPABILITIES_TIMEOUT_MS;
  const next = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = fetch("/api/provider/capabilities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as ProviderCapabilities;
      });
      return await Promise.race([
        request,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  })()
    .then((body) => {
      if (cacheGeneration !== generation) return null;
      if (body) cached = body;
      return body;
    })
    .catch(() => null)
    .finally(() => {
      if (inflight?.promise === next) inflight = null;
    });
  inflight = { controller, promise: next };
  return next;
}
