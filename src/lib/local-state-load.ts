/**
 * Coalesce concurrent POST /api/state/load callers (dual-pane history restore
 * + workbench list). Does not long-cache: once the inflight settles, the next
 * caller hits the network so mutations stay visible.
 */

let inflight: Promise<unknown> | null = null;

function requestLocalStateProjection(): Promise<unknown> {
  return fetch("/api/state/load", { method: "POST" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Local state could not be loaded.");
      return response.json();
    });
}

export async function loadLocalStateProjection(): Promise<unknown> {
  if (inflight) return inflight;
  inflight = requestLocalStateProjection()
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Read after a mutation without reusing a snapshot that may have started
 * before that mutation completed.
 */
export function loadFreshLocalStateProjection(): Promise<unknown> {
  return requestLocalStateProjection();
}
