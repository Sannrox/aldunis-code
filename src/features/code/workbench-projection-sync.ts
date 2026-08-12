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
  let events: ProjectionEventSource | null = null;
  let running = false;
  let backgroundQueued = false;
  let backgroundFresh = false;
  const explicitQueue: Array<{
    resolve(): void;
    reject(error: unknown): void;
  }> = [];

  const run = async (
    fresh: boolean,
    completion?: { resolve(): void; reject(error: unknown): void },
  ): Promise<void> => {
    try {
      const projection = await options.load(fresh);
      if (active) options.accept(workbenchProjectionSnapshot(projection));
      completion?.resolve();
    } catch (error) {
      // Background synchronization preserves the last accepted snapshot.
      completion?.reject(error);
    } finally {
      running = false;
      pump();
    }
  };

  const pump = (): void => {
    if (!active || running) return;
    const explicit = explicitQueue.shift();
    if (explicit) {
      // This fresh read also satisfies background work queued before it.
      backgroundQueued = false;
      backgroundFresh = false;
      running = true;
      void run(true, explicit);
      return;
    }
    if (!backgroundQueued) return;
    const fresh = backgroundFresh;
    backgroundQueued = false;
    backgroundFresh = false;
    running = true;
    void run(fresh);
  };

  const synchronizeInBackground = (fresh: boolean): void => {
    if (!active) return;
    backgroundQueued = true;
    backgroundFresh ||= fresh;
    pump();
  };

  return {
    start() {
      if (!active || events) return;
      synchronizeInBackground(false);
      events = options.createEventSource();
      events.addEventListener("open", () => synchronizeInBackground(true));
      events.addEventListener("thread_status", (event) => {
        try {
          if (!isThreadStatusEvent(JSON.parse(event.data) as unknown)) return;
          synchronizeInBackground(true);
        } catch {
          // Malformed events cannot replace the last accepted snapshot.
        }
      });
    },
    refresh() {
      if (!active) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        explicitQueue.push({ resolve, reject });
        pump();
      });
    },
    dispose() {
      active = false;
      backgroundQueued = false;
      backgroundFresh = false;
      for (const completion of explicitQueue.splice(0)) completion.resolve();
      events?.close();
      events = null;
    },
  };
}
