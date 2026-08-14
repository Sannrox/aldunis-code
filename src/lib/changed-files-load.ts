import type { ChangedFile } from "../types";

/**
 * Coalesce concurrent POST /api/changes callers (sidebar badge + pane panel).
 * Inflight-only: once a request settles the next caller hits the network so
 * post-mutation refreshes stay visible.
 */

export interface ChangedFilesSnapshot {
  files: ChangedFile[];
  truncated: boolean;
}

const inflight = new Map<string, Promise<ChangedFilesSnapshot>>();
let activeRequests = 0;
export const CHANGED_FILES_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ACTIVE_CHANGED_FILES_REQUESTS = 8;

interface ChangedFilesLoadOptions {
  root: string;
  worktree: string;
  timeoutMs?: number;
}

function cacheKey(root: string, worktree: string, timeoutMs: number): string {
  return `${root}\0${worktree}\0${timeoutMs}`;
}

async function requestChangedFiles(
  options: ChangedFilesLoadOptions,
): Promise<ChangedFilesSnapshot> {
  const controller = new AbortController();
  let rejectTimeout: ((reason: Error) => void) | undefined;
  const timeoutResult = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(new Error("Changed files request timed out."));
  }, options.timeoutMs ?? CHANGED_FILES_REQUEST_TIMEOUT_MS);
  try {
    return await Promise.race([
      fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: options.root, worktree: options.worktree }),
        signal: controller.signal,
      }).then(async (response) => {
        const body = (await response.json()) as {
          files?: ChangedFile[];
          truncated?: boolean;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(body.error ?? "Changed files could not be inspected.");
        }
        return { files: body.files ?? [], truncated: body.truncated === true };
      }),
      timeoutResult,
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Changed files request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestBoundedChangedFiles(
  options: ChangedFilesLoadOptions,
): Promise<ChangedFilesSnapshot> {
  if (activeRequests >= MAX_ACTIVE_CHANGED_FILES_REQUESTS) {
    throw new Error("Too many changed-file requests are already active.");
  }
  activeRequests += 1;
  try {
    return await requestChangedFiles(options);
  } finally {
    activeRequests -= 1;
  }
}

export async function loadChangedFiles(
  options: ChangedFilesLoadOptions,
): Promise<ChangedFilesSnapshot> {
  const timeoutMs = options.timeoutMs ?? CHANGED_FILES_REQUEST_TIMEOUT_MS;
  const key = cacheKey(options.root, options.worktree, timeoutMs);
  const pending = inflight.get(key);
  if (pending) return pending;
  const next = requestBoundedChangedFiles(options).finally(() => {
    if (inflight.get(key) === next) inflight.delete(key);
  });
  inflight.set(key, next);
  return next;
}

/** Bypass an older inflight snapshot after a known mutation. */
export function loadFreshChangedFiles(
  options: ChangedFilesLoadOptions,
): Promise<ChangedFilesSnapshot> {
  return requestBoundedChangedFiles(options);
}

/** Test helper — drop shared inflight state between cases. */
export function resetChangedFilesLoadForTests(): void {
  inflight.clear();
}
