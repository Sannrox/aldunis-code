import type { StateProjection } from "./state.ts";

/**
 * Workbench/list payload: keep lifecycle metadata, drop transcript bodies.
 * `/api/state/load` is polled and SSE-driven; shipping full messages/activities
 * on every status change dominated loopback bandwidth and client parse cost.
 *
 * Array membership is shallow-copied so a concurrent provider event cannot grow
 * or shrink the lists while the host finishes preferences/worktree awaits. Nested
 * records remain shared (no multi-MB structuredClone).
 */
export function projectWorkbenchState(projection: StateProjection): StateProjection {
  return {
    schemaVersion: projection.schemaVersion,
    sequence: projection.sequence,
    projects: projection.projects.slice(),
    threads: projection.threads.slice(),
    turns: projection.turns.slice(),
    messages: [],
    activities: [],
    plans: [],
    contextReceipts: [],
    usageReceipts: projection.usageReceipts.slice(),
    governanceCorrelations: projection.governanceCorrelations.slice(),
    providerSessions: projection.providerSessions.slice(),
    checkpoints: projection.checkpoints.slice(),
    annotations: [],
    fileReviews: [],
    conversationDeletions: projection.conversationDeletions.slice(),
    forks: projection.forks.slice(),
    delegatedRelationships: projection.delegatedRelationships.slice(),
    inputRequests: [],
    inputReceipts: projection.inputReceipts.slice(),
    automationFires: projection.automationFires.slice(),
    autonomyRuns: projection.autonomyRuns.slice(),
    autonomyTasks: projection.autonomyTasks.slice(),
    autonomyFlows: projection.autonomyFlows.slice(),
    heartbeatMonitors: projection.heartbeatMonitors.slice(),
    standingOrders: projection.standingOrders.slice(),
    autonomyHooks: projection.autonomyHooks.slice(),
  };
}

/**
 * Thread-scoped restore payload for one conversation. Callers that need
 * transcript bodies fetch this instead of the workbench list projection.
 */
export function projectConversationHistory(
  projection: StateProjection,
  threadId: string,
): Pick<
  StateProjection,
  | "threads"
  | "turns"
  | "messages"
  | "activities"
  | "plans"
  | "contextReceipts"
  | "inputRequests"
  | "providerSessions"
  | "governanceCorrelations"
  | "checkpoints"
> | null {
  const thread = projection.threads.find((item) => item.id === threadId);
  if (!thread) return null;
  const turns = projection.turns.filter((turn) => turn.threadId === threadId);
  const turnIds = new Set(turns.map((turn) => turn.id));
  return {
    threads: [thread],
    turns,
    messages: projection.messages.filter((message) => turnIds.has(message.turnId)),
    activities: projection.activities.filter((activity) => turnIds.has(activity.turnId)),
    plans: projection.plans.filter((plan) => plan.threadId === threadId),
    contextReceipts: projection.contextReceipts.filter((receipt) => receipt.threadId === threadId),
    inputRequests: projection.inputRequests.filter((request) => request.threadId === threadId),
    providerSessions: projection.providerSessions.filter(
      (session) => session.threadId === threadId,
    ),
    governanceCorrelations: projection.governanceCorrelations.filter(
      (receipt) => receipt.threadId === threadId,
    ),
    checkpoints: projection.checkpoints.filter((checkpoint) => checkpoint.threadId === threadId),
  };
}
