import type {
  ConversationSummary,
  DelegatedApprovalProjection,
  DelegatedConversationOutcomeProjection,
  DelegatedConversationRelationship,
  DelegatedInputProjection,
} from "../../types";
import {
  conversationListFromProjection,
  type ConversationListProjection,
} from "./conversation-list";

export type WorkbenchStateProjection = ConversationListProjection & {
  conversationDeletions?: Array<{ threadId: string; status: string }>;
  delegatedOutcomes?: DelegatedConversationOutcomeProjection[];
  delegatedApprovals?: DelegatedApprovalProjection[];
  delegatedInputs?: DelegatedInputProjection[];
  delegatedRelationships?: DelegatedConversationRelationship[];
  managedWorktreeCount?: number;
  managedWorktreeLimit?: number | null;
  managedWorktreePaths?: string[];
  error?: string;
};

export type WorkbenchProjectionSnapshot = {
  conversations: ConversationSummary[];
  delegatedRelationships: DelegatedConversationRelationship[];
  delegatedOutcomes: DelegatedConversationOutcomeProjection[];
  delegatedApprovals: DelegatedApprovalProjection[];
  delegatedInputs: DelegatedInputProjection[];
  incompleteDeletionIds: string[];
  managedWorktreeCount?: number;
  managedWorktreePaths?: string[];
};

export function workbenchProjectionSnapshot(
  projection: WorkbenchStateProjection,
): WorkbenchProjectionSnapshot {
  if (projection.error) throw new Error(projection.error);
  const conversations = conversationListFromProjection(projection);
  return {
    conversations,
    delegatedRelationships: projection.delegatedRelationships ?? [],
    delegatedOutcomes: projection.delegatedOutcomes ?? [],
    delegatedApprovals: projection.delegatedApprovals ?? [],
    delegatedInputs: projection.delegatedInputs ?? [],
    incompleteDeletionIds: (projection.conversationDeletions ?? [])
      .filter((deletion) => deletion.status !== "completed")
      .map((deletion) => deletion.threadId),
    ...(typeof projection.managedWorktreeCount === "number"
      ? { managedWorktreeCount: projection.managedWorktreeCount }
      : {}),
    ...(Array.isArray(projection.managedWorktreePaths)
      ? {
          managedWorktreePaths: projection.managedWorktreePaths.filter(
            (path): path is string => typeof path === "string",
          ),
        }
      : {}),
  };
}

export function reconcileWorkbenchConversations(
  projected: readonly ConversationSummary[],
  current: readonly ConversationSummary[],
): ConversationSummary[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return projected.map((conversation) => {
    const optimisticVisit = currentById.get(conversation.id)?.lastVisitedAt;
    return optimisticVisit &&
      (!conversation.lastVisitedAt || optimisticVisit > conversation.lastVisitedAt)
      ? { ...conversation, lastVisitedAt: optimisticVisit }
      : conversation;
  });
}

type ProjectionEvent = { data: string };
type ProjectionEventSource = {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "thread_status", listener: (event: ProjectionEvent) => void): void;
  close(): void;
};

type WorkbenchProjectionSynchronizationOptions = {
  load(fresh: boolean): Promise<WorkbenchStateProjection>;
  createEventSource(): ProjectionEventSource;
  accept(snapshot: WorkbenchProjectionSnapshot): void;
};

export type WorkbenchProjectionSynchronization = {
  start(): void;
  refresh(): Promise<void>;
  dispose(): void;
};

export function isThreadStatusEvent(value: unknown): value is {
  threadId: string;
  status: string;
  at: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.threadId === "string" &&
    typeof event.status === "string" &&
    typeof event.at === "string"
  );
}

export function createWorkbenchProjectionSynchronization(
  options: WorkbenchProjectionSynchronizationOptions,
): WorkbenchProjectionSynchronization {
  let active = true;
  let sequence = 0;
  let events: ProjectionEventSource | null = null;

  const synchronize = async (fresh: boolean, suppressFailure: boolean): Promise<void> => {
    if (!active) return;
    const requestSequence = ++sequence;
    try {
      const projection = await options.load(fresh);
      if (!active || requestSequence !== sequence) return;
      options.accept(workbenchProjectionSnapshot(projection));
    } catch (error) {
      // Keep the last accepted snapshot when refresh or normalization fails.
      if (!suppressFailure) throw error;
    }
  };

  return {
    start() {
      if (!active || events) return;
      void synchronize(false, true);
      events = options.createEventSource();
      events.addEventListener("open", () => void synchronize(true, true));
      events.addEventListener("thread_status", (event) => {
        try {
          if (!isThreadStatusEvent(JSON.parse(event.data) as unknown)) return;
          void synchronize(true, true);
        } catch {
          // Malformed events cannot replace the last accepted snapshot.
        }
      });
    },
    refresh() {
      return synchronize(true, false);
    },
    dispose() {
      active = false;
      sequence += 1;
      events?.close();
      events = null;
    },
  };
}
