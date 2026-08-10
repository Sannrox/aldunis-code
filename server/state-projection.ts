import type { StateProjection } from "./state.ts";

/**
 * Workbench/list payload: keep lifecycle metadata, drop transcript bodies.
 * `/api/state/load` is polled and SSE-driven; shipping full messages/activities
 * on every status change dominated loopback bandwidth and client parse cost.
 */
export function projectWorkbenchState(projection: StateProjection): StateProjection {
  return {
    ...projection,
    messages: [],
    activities: [],
    plans: [],
    contextReceipts: [],
    inputRequests: [],
    annotations: [],
    fileReviews: [],
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
    providerSessions: projection.providerSessions.filter((session) => session.threadId === threadId),
    governanceCorrelations: projection.governanceCorrelations.filter(
      (receipt) => receipt.threadId === threadId,
    ),
    checkpoints: projection.checkpoints.filter((checkpoint) => checkpoint.threadId === threadId),
  };
}
