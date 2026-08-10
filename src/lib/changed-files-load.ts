import type { ChangedFile } from "../types";

/**
 * Coalesce concurrent POST /api/changes callers (sidebar badge + pane panel).
 * Inflight-only: once a request settles the next caller hits the network so
 * post-mutation refreshes stay visible.
 */

const inflight = new Map<string, Promise<ChangedFile[]>>();

function cacheKey(root: string, worktree: string): string {
  return `${root}\0${worktree}`;
}

function requestChangedFiles(root: string, worktree: string): Promise<ChangedFile[]> {
  return fetch("/api/changes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, worktree }),
  }).then(async (response) => {
    const body = (await response.json()) as { files?: ChangedFile[]; error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? "Changed files could not be inspected.");
    }
    return body.files ?? [];
  });
}

export async function loadChangedFiles(options: {
  root: string;
  worktree: string;
}): Promise<ChangedFile[]> {
  const key = cacheKey(options.root, options.worktree);
  const pending = inflight.get(key);
  if (pending) return pending;
  const next = requestChangedFiles(options.root, options.worktree).finally(() => {
    if (inflight.get(key) === next) inflight.delete(key);
  });
  inflight.set(key, next);
  return next;
}

/** Bypass an older inflight snapshot after a known mutation. */
export function loadFreshChangedFiles(options: {
  root: string;
  worktree: string;
}): Promise<ChangedFile[]> {
  return requestChangedFiles(options.root, options.worktree);
}

/** Test helper — drop shared inflight state between cases. */
export function resetChangedFilesLoadForTests(): void {
  inflight.clear();
}
