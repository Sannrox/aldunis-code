import type { ConversationSummary, RepositoryMetadata } from "./types";

export type SplitWorkspacePane = "primary" | "secondary";
export interface SplitWorkspaceState {
  primaryId: string | null;
  secondaryId: string | null;
  activePane: SplitWorkspacePane;
  splitPercent: number;
}
export type SplitWorkspaceAction =
  | { type: "set_primary"; id: string | null }
  | { type: "set_secondary"; id: string | null }
  | { type: "focus"; pane: SplitWorkspacePane }
  | { type: "resize"; percent: number }
  | { type: "restore"; state: SplitWorkspaceState };
export interface SplitWorkspaceProject {
  id: string;
  memberIds?: string[];
}

export function clampSplitPercent(value: number): number {
  return Math.min(70, Math.max(30, Number.isFinite(value) ? value : 50));
}

export function normalizeSplitWorkspaceState(
  input: {
    primaryId?: unknown;
    secondaryId?: unknown;
    activePane?: unknown;
    splitPercent?: unknown;
  },
  fallbackPrimaryId: string | null,
): SplitWorkspaceState {
  const primaryId = typeof input.primaryId === "string" ? input.primaryId : fallbackPrimaryId;
  const candidate = typeof input.secondaryId === "string" ? input.secondaryId : null;
  const secondaryId = candidate === primaryId ? null : candidate;
  return {
    primaryId,
    secondaryId,
    activePane: input.activePane === "secondary" && secondaryId ? "secondary" : "primary",
    splitPercent: clampSplitPercent(
      typeof input.splitPercent === "number" ? input.splitPercent : 50,
    ),
  };
}

export function transitionSplitWorkspace(
  current: SplitWorkspaceState,
  action: SplitWorkspaceAction,
): SplitWorkspaceState {
  if (action.type === "restore")
    return normalizeSplitWorkspaceState(action.state, action.state.primaryId);
  if (action.type === "set_primary")
    return {
      ...current,
      primaryId: action.id,
      secondaryId: action.id === current.secondaryId ? null : current.secondaryId,
      activePane: action.id === current.secondaryId ? "primary" : current.activePane,
    };
  if (action.type === "set_secondary") {
    const secondaryId = action.id === current.primaryId ? null : action.id;
    return {
      ...current,
      secondaryId,
      activePane:
        !secondaryId && current.activePane === "secondary" ? "primary" : current.activePane,
    };
  }
  if (action.type === "focus")
    return {
      ...current,
      activePane: action.pane === "secondary" && !current.secondaryId ? "primary" : action.pane,
    };
  return { ...current, splitPercent: clampSplitPercent(action.percent) };
}

export function activeProjectIds(
  repositoryProjectId: string | null | undefined,
  projects: SplitWorkspaceProject[],
  additionalProjectId?: string | null,
): Set<string> {
  const project = projects.find((candidate) => candidate.id === repositoryProjectId);
  return new Set(
    [repositoryProjectId, ...(project?.memberIds ?? []), additionalProjectId].filter(
      Boolean,
    ) as string[],
  );
}

export function projectActivationTarget(
  primaryId: string | null,
  conversations: ConversationSummary[],
  currentProjectIds: Set<string>,
  requestedProjectId: string | null,
): string | null {
  if (!primaryId) return null;
  const thread = conversations.find((candidate) => candidate.id === primaryId);
  if (!thread || currentProjectIds.has(thread.projectId) || requestedProjectId === thread.projectId)
    return null;
  return thread.projectId;
}

export function selectSecondaryConversation(
  explicitId: string | undefined,
  conversations: ConversationSummary[],
  primaryId: string | null,
  currentProjectIds: Set<string>,
  createId: () => string,
): string {
  if (explicitId) return explicitId;
  return (
    conversations.find(
      (conversation) =>
        conversation.id !== primaryId &&
        !conversation.archivedAt &&
        !conversation.settledAt &&
        (currentProjectIds.size === 0 || currentProjectIds.has(conversation.projectId)),
    )?.id ?? `new:${createId()}`
  );
}

export function repositoryForSplitConversation(
  repository: RepositoryMetadata | null,
  conversation: ConversationSummary | null,
): RepositoryMetadata | null {
  if (!repository) return null;
  if (!conversation?.worktree) return repository;
  if (!repository.worktrees.some((worktree) => worktree.path === conversation.worktree))
    return repository;
  return {
    ...repository,
    selectedWorktree: conversation.worktree,
    name: conversation.projectName ?? repository.name,
  };
}
