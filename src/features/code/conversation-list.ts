import type {
  ConversationSummary,
  ProviderId,
  RepositoryMetadata,
  ThreadStatusProjection,
} from "../../types";
import {
  loadFreshLocalStateProjection,
  loadLocalStateProjection,
} from "../../lib/local-state-load";
import { isEffectivelySnoozed, threadNeedsAttentionWhileSnoozed } from "../../lib/thread-snooze";

export interface ConversationListProjection {
  threads: ConversationSummary[];
  projects?: Array<{ id: string; name: string }>;
  threadStatuses?: ThreadStatusProjection[];
  providerSessions?: Array<{
    threadId: string;
    provider: ProviderId;
    model: string | null;
    profileId?: string;
  }>;
}

export function conversationListFromProjection(
  projection: ConversationListProjection,
  projectId?: string | null,
): ConversationSummary[] {
  const statusById = new Map(
    (projection.threadStatuses ?? []).map((item) => [item.threadId, item]),
  );
  const projectNames = new Map(
    (projection.projects ?? []).map((project) => [project.id, project.name]),
  );
  const providerSessions = new Map(
    (projection.providerSessions ?? []).map((session) => [
      `${session.threadId}:${session.provider}`,
      session,
    ]),
  );
  return projection.threads
    .filter((thread) => !projectId || thread.projectId === projectId)
    .map((thread) => {
      const status = statusById.get(thread.id);
      const session = providerSessions.get(`${thread.id}:${thread.provider}`);
      return {
        ...thread,
        ...(thread.profileId == null && session?.profileId ? { profileId: session.profileId } : {}),
        ...(thread.model == null && session?.model ? { model: session.model } : {}),
        projectName: projectNames.get(thread.projectId) ?? thread.projectName ?? "project",
        status: status?.status ?? "idle",
        statusSince: status?.since ?? thread.updatedAt,
      };
    })
    .sort((left, right) => {
      if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
    });
}

/**
 * Load threads for the inbox. Pass a project id to scope, or null/undefined for
 * T3-style "All" (every registered project).
 */
export async function loadConversationList(
  projectId?: string | null,
  options: { fresh?: boolean } = {},
): Promise<ConversationSummary[]> {
  const loadProjection = options.fresh ? loadFreshLocalStateProjection : loadLocalStateProjection;
  const projection = (await loadProjection()) as ConversationListProjection;
  return conversationListFromProjection(projection, projectId);
}

/** @deprecated Prefer loadConversationList(projectId). Kept for call sites that pass a repository. */
export async function loadConversationListForRepository(
  repository: RepositoryMetadata,
): Promise<ConversationSummary[]> {
  return loadConversationList(repository.projectId);
}

export function isUnread(thread: ConversationSummary): boolean {
  if (!thread.wokeAt) return false;
  if (!thread.lastVisitedAt) return true;
  return thread.lastVisitedAt < thread.wokeAt;
}

export function isBlockingStatus(status: ConversationSummary["status"]): boolean {
  return status === "pending_approval" || status === "awaiting_input" || status === "failed";
}

export function groupSidebarConversations(
  conversations: ConversationSummary[],
  archivedView = false,
  now: Date | string | number = Date.now(),
): {
  attention: ConversationSummary[];
  active: ConversationSummary[];
  snoozed: ConversationSummary[];
  settled: ConversationSummary[];
} {
  const attention: ConversationSummary[] = [];
  const active: ConversationSummary[] = [];
  const snoozed: ConversationSummary[] = [];
  const settled: ConversationSummary[] = [];

  for (const conversation of conversations) {
    // Approval/input always surfaces, including while a future snooze is set.
    // Failed may be snoozed (visibility only), so check effective snooze first.
    if (
      !archivedView &&
      !conversation.archivedAt &&
      !conversation.settledAt &&
      threadNeedsAttentionWhileSnoozed(conversation)
    ) {
      attention.push(conversation);
      continue;
    }
    if (!archivedView && isEffectivelySnoozed(conversation, now)) {
      snoozed.push(conversation);
      continue;
    }
    if (conversation.settledAt) {
      settled.push(conversation);
    } else if (!archivedView && !conversation.archivedAt && isBlockingStatus(conversation.status)) {
      attention.push(conversation);
    } else {
      active.push(conversation);
    }
  }

  snoozed.sort(
    (left, right) =>
      (left.snoozedUntil ?? "").localeCompare(right.snoozedUntil ?? "") ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  settled.sort((left, right) => (right.settledAt ?? "").localeCompare(left.settledAt ?? ""));
  return { attention, active, snoozed, settled };
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

export { providerListLabel as providerLabel } from "../../lib/provider-readiness";

export function branchFromWorktree(worktree: string): string {
  const normalized = worktree.replace(/\\/g, "/");
  // Managed worktrees: .../.aldunis/wt/<branch path>
  const managed = normalized.split("/.aldunis/wt/")[1];
  if (managed) return managed;
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? worktree;
}
