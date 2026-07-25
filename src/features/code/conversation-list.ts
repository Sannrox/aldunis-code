import type { RepositoryMetadata, ConversationSummary } from "../../types";

export async function loadConversationList(repository: RepositoryMetadata): Promise<ConversationSummary[]> {
  const response = await fetch("/api/state/load", { method: "POST" });
  if (!response.ok) throw new Error("Conversation history could not be loaded.");
  const projection = await response.json() as { threads: ConversationSummary[] };
  return projection.threads
    .filter((thread) => thread.projectId === repository.projectId)
    .sort((left, right) => {
      if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
    });
}


