import type { ConversationSummary } from "../types";

export interface ConversationPaneSelection {
  primaryId: string | null;
  secondaryId: string | null;
}

export interface ConversationDeletionPreviewResult {
  affectedRecords?: Record<string, number>;
  excluded?: string[];
}

interface LifecycleResponse {
  error?: string;
  released?: boolean;
  managedWorktreeCount?: number;
}

type LifecycleFetch = typeof fetch;

export function repairConversationPanesAfterRemoval(
  selection: ConversationPaneSelection,
  threadId: string,
): ConversationPaneSelection {
  return {
    primaryId: selection.primaryId === threadId ? null : selection.primaryId,
    secondaryId: selection.secondaryId === threadId ? null : selection.secondaryId,
  };
}

export function bulkReleaseFailureMessage(
  released: number,
  targets: readonly ConversationSummary[],
  failures: readonly string[],
): string | null {
  if (failures.length === 0) return null;
  const preview = failures.slice(0, 3).join("; ");
  const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : "";
  return `Released ${released} of ${targets.length}. ${preview}${more}`;
}

/**
 * Owns conversation lifecycle transport (pin/archive/settle/release/delete)
 * behind named methods. Callers must not assemble host route strings.
 */
export class ConversationLifecycleControl {
  constructor(
    private readonly refresh: () => Promise<unknown>,
    private readonly request: LifecycleFetch = fetch,
  ) {}

  async pin(threadId: string, pinned: boolean): Promise<void> {
    await this.mutate("/api/state/conversations/pin", { threadId, pinned }, "Pin update failed.");
  }

  async archive(threadId: string): Promise<void> {
    await this.mutate(
      "/api/state/conversations/archive",
      { threadId },
      "Conversation archive failed.",
    );
  }

  async restore(threadId: string): Promise<void> {
    await this.mutate(
      "/api/state/conversations/restore",
      { threadId },
      "Conversation restore failed.",
    );
  }

  async rename(threadId: string, title: string): Promise<void> {
    await this.mutate(
      "/api/state/conversations/rename",
      { threadId, title },
      "Conversation rename failed.",
    );
  }

  async settle(threadId: string): Promise<void> {
    await this.mutate(
      "/api/state/conversations/settle",
      { threadId },
      "Conversation could not be settled.",
    );
  }

  async unsettle(threadId: string): Promise<void> {
    await this.mutate(
      "/api/state/conversations/unsettle",
      { threadId },
      "Conversation could not be unsettled.",
    );
  }

  async snooze(threadId: string, snoozedUntil: string): Promise<void> {
    await this.mutate(
      "/api/state/conversations/snooze",
      { threadId, snoozedUntil },
      "Snooze failed.",
    );
  }

  async unsnooze(threadId: string): Promise<void> {
    await this.mutate("/api/state/conversations/unsnooze", { threadId }, "Unsnooze failed.");
  }

  async confirmDelete(threadId: string): Promise<void> {
    await this.mutate(
      "/api/state/conversations/delete",
      { threadId, confirm: true },
      "Conversation deletion failed.",
    );
  }

  async releaseWorktree(threadId: string): Promise<LifecycleResponse> {
    return this.mutate(
      "/api/state/conversations/release-worktree",
      { threadId, confirm: true },
      "Managed worktree release failed.",
    );
  }

  async settleAndRelease(threadId: string): Promise<void> {
    await this.settle(threadId);
    await this.releaseWorktree(threadId);
  }

  async previewDeletion(threadId: string): Promise<ConversationDeletionPreviewResult> {
    const response = await this.request("/api/state/conversations/delete/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
    const result = (await response.json()) as ConversationDeletionPreviewResult & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Deletion preview failed.");
    return result;
  }

  async deleteConversation(
    threadId: string,
    selection: ConversationPaneSelection,
  ): Promise<{ selection: ConversationPaneSelection; refreshFailed: boolean }> {
    const response = await this.request("/api/state/conversations/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, confirm: true }),
    });
    const result = (await response.json()) as LifecycleResponse;
    if (!response.ok) throw new Error(result.error ?? "Conversation deletion failed.");
    let refreshFailed = false;
    try {
      await this.refresh();
    } catch {
      refreshFailed = true;
    }
    return { selection: repairConversationPanesAfterRemoval(selection, threadId), refreshFailed };
  }

  async releaseSettled(
    targets: readonly ConversationSummary[],
    onManagedCount: (count: number) => void,
  ): Promise<void> {
    const failures: string[] = [];
    let released = 0;
    for (const conversation of targets) {
      try {
        const result = await this.releaseWorktreeWithoutRefresh(conversation.id);
        if (result.released) released += 1;
        if (typeof result.managedWorktreeCount === "number") {
          onManagedCount(result.managedWorktreeCount);
        }
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Managed worktree release failed.";
        failures.push(`${conversation.title}: ${message}`);
      }
    }
    try {
      await this.refresh();
    } catch {
      // Successful responses already projected the managed count when available.
    }
    const failure = bulkReleaseFailureMessage(released, targets, failures);
    if (failure) throw new Error(failure);
  }

  private async mutate(
    route: string,
    body: Record<string, unknown>,
    fallback: string,
  ): Promise<LifecycleResponse> {
    const result = await this.post(route, body, fallback);
    await this.refresh();
    return result;
  }

  private async releaseWorktreeWithoutRefresh(threadId: string): Promise<LifecycleResponse> {
    return this.post(
      "/api/state/conversations/release-worktree",
      { threadId, confirm: true },
      "Managed worktree release failed.",
    );
  }

  private async post(
    route: string,
    body: Record<string, unknown>,
    fallback: string,
  ): Promise<LifecycleResponse> {
    const response = await this.request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as LifecycleResponse;
    if (!response.ok) throw new Error(result.error ?? fallback);
    return result;
  }
}
