import { useEffect, useState, useSyncExternalStore } from "react";
import { hostFetch } from "../../lib/host-fetch";
import type { ForkPreview, ProviderId, WorkspaceMode } from "../../types";

export type ForkFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReviewedForkSnapshot {
  preview: ForkPreview | null;
  error: string | null;
  busy: boolean;
}

export interface ReviewedForkSessionAdapters {
  request?: ForkFetch;
}

export interface ReviewedForkCreateInput {
  sourceThreadId: string;
  provider: ProviderId;
  profileId: string | null;
  model: string;
  worktree?: string;
  workspaceMode: WorkspaceMode;
}

function forkError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForkPreview(value: unknown): value is ForkPreview {
  if (!isRecord(value)) return false;
  return (
    typeof value.sourceThreadId === "string" &&
    typeof value.worktree === "string" &&
    typeof value.digest === "string" &&
    typeof value.workspaceMode === "string" &&
    typeof value.byteCount === "number" &&
    Array.isArray(value.messages) &&
    Array.isArray(value.annotations) &&
    Array.isArray(value.excluded) &&
    isRecord(value.contextPackage)
  );
}

function createdThreadId(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.thread)) return null;
  return typeof body.thread.id === "string" && body.thread.id.trim() ? body.thread.id : null;
}

export function initialReviewedForkSnapshot(): ReviewedForkSnapshot {
  return { preview: null, error: null, busy: true };
}

/**
 * Owns Code-hosted reviewed-fork preview and create transport while
 * ForkConversationDialog retains destination, workspace, and review chrome
 * and the host retains fork admission.
 */
export class ReviewedForkSessionModule {
  private snapshot: ReviewedForkSnapshot = initialReviewedForkSnapshot();
  private readonly listeners = new Set<() => void>();
  private operationId = 0;
  private readonly request: ForkFetch;

  constructor(adapters: ReviewedForkSessionAdapters = {}) {
    this.request = adapters.request ?? hostFetch;
  }

  getSnapshot = (): ReviewedForkSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reset(): void {
    this.operationId += 1;
    this.replace(initialReviewedForkSnapshot());
  }

  async preview(sourceThreadId: string): Promise<void> {
    const operationId = ++this.operationId;
    this.patch({ preview: null, busy: true, error: null });
    try {
      const response = await this.request("/api/forks/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceThreadId }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return;
      if (!response.ok) {
        throw new Error(forkError(result, "The fork preview could not be prepared."));
      }
      if (!isForkPreview(result)) {
        throw new Error("The fork preview could not be prepared.");
      }
      this.patch({ preview: result, busy: false });
    } catch (cause) {
      if (operationId !== this.operationId) return;
      this.patch({
        busy: false,
        error: cause instanceof Error ? cause.message : "The fork preview failed.",
      });
    }
  }

  async create(input: ReviewedForkCreateInput): Promise<string | null> {
    const preview = this.snapshot.preview;
    if (!preview || preview.sourceThreadId !== input.sourceThreadId) return null;
    const operationId = ++this.operationId;
    this.patch({ busy: true, error: null });
    try {
      const response = await this.request("/api/forks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId: input.sourceThreadId,
          provider: input.provider,
          profileId: input.profileId,
          model: input.model,
          expectedDigest: preview.digest,
          worktree: input.worktree,
          workspaceMode: input.workspaceMode,
        }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return null;
      if (!response.ok) {
        throw new Error(forkError(result, "The fork could not be created."));
      }
      const threadId = createdThreadId(result);
      if (!threadId) throw new Error("The fork could not be created.");
      return threadId;
    } catch (cause) {
      if (operationId !== this.operationId) return null;
      this.patch({
        busy: false,
        error: cause instanceof Error ? cause.message : "The fork failed.",
      });
      return null;
    }
  }

  private patch(next: Partial<ReviewedForkSnapshot>): void {
    this.replace({ ...this.snapshot, ...next });
  }

  private replace(snapshot: ReviewedForkSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function useReviewedForkSession(options: { sourceThreadId: string }): {
  snapshot: ReviewedForkSnapshot;
  session: ReviewedForkSessionModule;
} {
  const [session] = useState(() => new ReviewedForkSessionModule());
  const raw = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const snapshot =
    raw.preview && raw.preview.sourceThreadId !== options.sourceThreadId
      ? { preview: null, error: null, busy: true }
      : raw;
  useEffect(() => {
    session.reset();
    void session.preview(options.sourceThreadId);
  }, [options.sourceThreadId, session]);
  return { snapshot, session };
}
