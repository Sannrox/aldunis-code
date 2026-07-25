import type {
  ConversationSummary,
  RepositoryMetadata,
  ThreadStatusProjection,
} from "../../types";

export async function loadConversationList(
  repository: RepositoryMetadata,
): Promise<ConversationSummary[]> {
  const response = await fetch("/api/state/load", { method: "POST" });
  if (!response.ok) throw new Error("Conversation history could not be loaded.");
  const projection = await response.json() as {
    threads: ConversationSummary[];
    projects?: Array<{ id: string; name: string }>;
    threadStatuses?: ThreadStatusProjection[];
  };
  const statusById = new Map(
    (projection.threadStatuses ?? []).map((item) => [item.threadId, item]),
  );
  const projectName = projection.projects?.find((p) => p.id === repository.projectId)?.name
    ?? repository.name;
  return projection.threads
    .filter((thread) => thread.projectId === repository.projectId)
    .map((thread) => {
      const status = statusById.get(thread.id);
      return {
        ...thread,
        projectName,
        status: status?.status ?? "idle",
        statusSince: status?.since ?? thread.updatedAt,
      };
    })
    .sort((left, right) => {
      if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
    });
}

export function isUnread(thread: ConversationSummary): boolean {
  if (!thread.wokeAt) return false;
  if (!thread.lastVisitedAt) return true;
  return thread.lastVisitedAt < thread.wokeAt;
}

export function isBlockingStatus(status: ConversationSummary["status"]): boolean {
  return status === "pending_approval" || status === "awaiting_input" || status === "failed";
}

export function formatElapsed(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function providerLabel(provider: string): string {
  if (provider === "claude-code") return "Claude";
  if (provider === "codex-cli") return "Codex";
  if (provider.startsWith("adapter:")) {
    const id = provider.slice("adapter:".length).split("@")[0] ?? provider;
    return id;
  }
  return provider;
}

export function branchFromWorktree(worktree: string): string {
  const parts = worktree.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? worktree;
}
