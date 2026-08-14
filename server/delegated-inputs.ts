import { LocalStateError, type ChildInputRequest, type StateProjection } from "./state.ts";

export interface DelegatedInputProjection {
  parentThreadId: string;
  childThreadId: string;
  request: ChildInputRequest;
}

export function projectDelegatedInputs(projection: StateProjection): DelegatedInputProjection[] {
  const requests = projection.inputRequests.filter(
    (request) =>
      request.state === "pending" ||
      (request.responseMode === "native_resume" && request.resumeState === "unavailable"),
  );
  if (requests.length === 0) return [];

  const remainingTurnIds = new Set(requests.map((request) => request.turnId));
  const remainingChildIds = new Set(requests.map((request) => request.threadId));
  const turnById = new Map<string, StateProjection["turns"][number]>();
  const relationshipByChild = new Map<string, StateProjection["delegatedRelationships"][number]>();
  for (let index = projection.turns.length - 1; index >= 0; index -= 1) {
    const turn = projection.turns[index];
    if (!remainingTurnIds.delete(turn.id)) continue;
    turnById.set(turn.id, turn);
    if (remainingTurnIds.size === 0) break;
  }
  for (let index = projection.delegatedRelationships.length - 1; index >= 0; index -= 1) {
    const relationship = projection.delegatedRelationships[index];
    if (!remainingChildIds.delete(relationship.childThreadId)) continue;
    relationshipByChild.set(relationship.childThreadId, relationship);
    if (remainingChildIds.size === 0) break;
  }

  return requests
    .flatMap((request) => {
      const unavailableNativeResume =
        request.responseMode === "native_resume" && request.resumeState === "unavailable";
      const relationship = relationshipByChild.get(request.threadId);
      const candidate = turnById.get(request.turnId);
      const turn =
        candidate &&
        candidate.providerRunId === request.providerRunId &&
        (candidate.status === "waiting_for_user" ||
          (unavailableNativeResume &&
            ["interrupted", "failed", "cancelled"].includes(candidate.status)))
          ? candidate
          : undefined;
      return relationship && turn
        ? [
            {
              parentThreadId: relationship.parentThreadId,
              childThreadId: relationship.childThreadId,
              request,
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        left.request.createdAt.localeCompare(right.request.createdAt) ||
        left.request.id.localeCompare(right.request.id),
    );
}

export function assertParentRoutedInput(
  projection: StateProjection,
  parentThreadId: string,
  childThreadId: string,
  requestId: string,
): ChildInputRequest {
  const relationship = projection.delegatedRelationships.find(
    (item) => item.parentThreadId === parentThreadId && item.childThreadId === childThreadId,
  );
  const request = projection.inputRequests.find(
    (item) => item.id === requestId && item.threadId === childThreadId,
  );
  if (!relationship || !request) {
    throw new LocalStateError(
      "The input request is not pending for an explicitly related child.",
      403,
    );
  }
  return request;
}
