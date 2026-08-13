import { useEffect, useState, useSyncExternalStore } from "react";
import type { CheckpointFile } from "../../types";

export type RewindFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface WorkspaceRewindPreview {
  checkpointId: string;
  root: string;
  worktree: string;
  currentIdentity: string;
  currentIndexIdentity: string;
  files: CheckpointFile[];
}

export interface WorkspaceRewindSnapshot {
  preview: WorkspaceRewindPreview | null;
  error: string | null;
  busy: boolean;
}

export interface WorkspaceRewindSessionAdapters {
  request?: RewindFetch;
}

function rewindError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRewindPreviewPayload(
  value: unknown,
): value is Pick<WorkspaceRewindPreview, "currentIdentity" | "currentIndexIdentity" | "files"> {
  if (!isRecord(value) || !Array.isArray(value.files)) return false;
  return (
    typeof value.currentIdentity === "string" &&
    value.currentIdentity.trim() !== "" &&
    typeof value.currentIndexIdentity === "string" &&
    value.currentIndexIdentity.trim() !== ""
  );
}

export function initialWorkspaceRewindSnapshot(): WorkspaceRewindSnapshot {
  return { preview: null, error: null, busy: false };
}

/**
 * Owns Code-hosted checkpoint rewind preview and confirm while Conversation
 * retains checkpoint chrome and the host retains Git rewind authority.
 */
export class WorkspaceRewindSessionModule {
  private snapshot: WorkspaceRewindSnapshot = initialWorkspaceRewindSnapshot();
  private readonly listeners = new Set<() => void>();
  private operationId = 0;
  private readonly request: RewindFetch;

  constructor(adapters: WorkspaceRewindSessionAdapters = {}) {
    this.request = adapters.request ?? fetch;
  }

  getSnapshot = (): WorkspaceRewindSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reset(): void {
    this.operationId += 1;
    this.replace(initialWorkspaceRewindSnapshot());
  }

  clearPreview(): void {
    this.patch({ preview: null });
  }

  async preview(checkpointId: string, root: string, worktree: string): Promise<void> {
    const operationId = ++this.operationId;
    this.patch({ preview: null, busy: true, error: null });
    try {
      const response = await this.request(`/api/checkpoints/${checkpointId}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, worktree }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return;
      if (!response.ok) {
        throw new Error(rewindError(result, "The rewind preview could not be prepared."));
      }
      if (!isRewindPreviewPayload(result)) {
        throw new Error("The rewind preview could not be prepared.");
      }
      this.patch({
        preview: {
          checkpointId,
          root,
          worktree,
          currentIdentity: result.currentIdentity,
          currentIndexIdentity: result.currentIndexIdentity,
          files: result.files,
        },
        busy: false,
      });
    } catch (cause) {
      if (operationId !== this.operationId) return;
      this.patch({
        busy: false,
        error: cause instanceof Error ? cause.message : "The rewind preview failed.",
      });
    }
  }

  async confirm(checkpointId: string, root: string, worktree: string): Promise<boolean> {
    const preview = this.snapshot.preview;
    if (
      !preview ||
      preview.checkpointId !== checkpointId ||
      preview.root !== root ||
      preview.worktree !== worktree
    ) {
      return false;
    }
    const operationId = ++this.operationId;
    this.patch({ busy: true, error: null });
    try {
      const response = await this.request(`/api/checkpoints/${checkpointId}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root,
          worktree,
          currentIdentity: preview.currentIdentity,
          currentIndexIdentity: preview.currentIndexIdentity,
          confirm: true,
        }),
      });
      const result: unknown = await response.json();
      if (operationId !== this.operationId) return false;
      if (!response.ok) {
        throw new Error(rewindError(result, "The workspace could not be rewound."));
      }
      this.patch({ preview: null, busy: false });
      return true;
    } catch (cause) {
      if (operationId !== this.operationId) return false;
      this.patch({
        busy: false,
        error: cause instanceof Error ? cause.message : "The workspace rewind failed.",
      });
      return false;
    }
  }

  private patch(next: Partial<WorkspaceRewindSnapshot>): void {
    this.replace({ ...this.snapshot, ...next });
  }

  private replace(snapshot: WorkspaceRewindSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function useWorkspaceRewindSession(options: {
  checkpointId: string | null;
  root: string;
  worktree: string;
}): { snapshot: WorkspaceRewindSnapshot; session: WorkspaceRewindSessionModule } {
  const [session] = useState(() => new WorkspaceRewindSessionModule());
  const raw = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const snapshot =
    raw.preview &&
    (raw.preview.checkpointId !== options.checkpointId ||
      raw.preview.root !== options.root ||
      raw.preview.worktree !== options.worktree)
      ? { preview: null, error: null, busy: false }
      : raw;
  useEffect(() => {
    session.reset();
  }, [options.checkpointId, options.root, options.worktree, session]);
  return { snapshot, session };
}
