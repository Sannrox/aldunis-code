import { LocalStateError, type ChildInputRequest, type StateProjection } from "./state.ts";

export interface DelegatedInputProjection {
  parentThreadId: string;
  childThreadId: string;
  request: ChildInputRequest;
}

export function projectDelegatedInputs(projection: StateProjection): DelegatedInputProjection[] {
  const relationshipByChild = new Map(
    projection.delegatedRelationships.map((relationship) => [
      relationship.childThreadId,
      relationship,
    ]),
  );
  return projection.inputRequests.flatMap((request) => {
    const unavailableNativeResume = request.responseMode === "native_resume"
      && request.resumeState === "unavailable";
    if (request.state !== "pending" && !unavailableNativeResume) return [];
    const relationship = relationshipByChild.get(request.threadId);
    const turn = projection.turns.find((item) => (
      item.id === request.turnId
      && item.providerRunId === request.providerRunId
      && (
        item.status === "waiting_for_user"
        || (
          unavailableNativeResume
          && ["interrupted", "failed", "cancelled"].includes(item.status)
        )
      )
    ));
    return relationship && turn ? [{
      parentThreadId: relationship.parentThreadId,
      childThreadId: relationship.childThreadId,
      request,
    }] : [];
  }).sort((left, right) => (
    left.request.createdAt.localeCompare(right.request.createdAt)
    || left.request.id.localeCompare(right.request.id)
  ));
}

export function assertParentRoutedInput(
  projection: StateProjection,
  parentThreadId: string,
  childThreadId: string,
  requestId: string,
): ChildInputRequest {
  const relationship = projection.delegatedRelationships.find((item) => (
    item.parentThreadId === parentThreadId && item.childThreadId === childThreadId
  ));
  const request = projection.inputRequests.find((item) => (
    item.id === requestId && item.threadId === childThreadId
  ));
  if (!relationship || !request) {
    throw new LocalStateError(
      "The input request is not pending for an explicitly related child.",
      403,
    );
  }
  return request;
}
