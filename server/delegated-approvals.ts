import type { ApprovalSnapshot } from "./permission.ts";
import type { StateProjection } from "./state.ts";
import { PermissionError } from "./permission.ts";

export interface DelegatedApprovalProjection {
  parentThreadId: string;
  childThreadId: string;
  approval: ApprovalSnapshot;
}

export function projectDelegatedApprovals(
  projection: StateProjection,
  approvals: ApprovalSnapshot[],
): DelegatedApprovalProjection[] {
  const latestTurnByThread = new Map<string, StateProjection["turns"][number]>();
  for (const turn of projection.turns) latestTurnByThread.set(turn.threadId, turn);
  const relationshipByChild = new Map(
    projection.delegatedRelationships.map((relationship) => [
      relationship.childThreadId,
      relationship,
    ]),
  );

  return approvals
    .flatMap((approval) => {
      if (approval.state !== "pending") return [];
      const relationship = relationshipByChild.get(approval.conversationId);
      const turn = relationship ? latestTurnByThread.get(relationship.childThreadId) : undefined;
      if (
        !relationship ||
        !turn ||
        !["active", "running", "waiting_for_approval"].includes(turn.status) ||
        turn.providerRunId !== approval.runId
      )
        return [];
      return [
        {
          parentThreadId: relationship.parentThreadId,
          childThreadId: relationship.childThreadId,
          approval,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.approval.expiresAt.localeCompare(right.approval.expiresAt) ||
        left.approval.id.localeCompare(right.approval.id),
    );
}

export function assertParentRoutedApproval(
  projection: StateProjection,
  approvals: ApprovalSnapshot[],
  binding: {
    parentThreadId: string;
    childThreadId: string;
    approvalId: string;
  },
): void {
  const relationship = projection.delegatedRelationships.find(
    (item) =>
      item.parentThreadId === binding.parentThreadId &&
      item.childThreadId === binding.childThreadId,
  );
  const approval = approvals.find((item) => item.id === binding.approvalId);
  let latestTurn: StateProjection["turns"][number] | undefined;
  if (relationship && approval) {
    for (let index = projection.turns.length - 1; index >= 0; index -= 1) {
      const turn = projection.turns[index];
      if (turn.threadId !== binding.childThreadId) continue;
      latestTurn = turn;
      break;
    }
  }
  if (
    !relationship ||
    !latestTurn ||
    !approval ||
    approval.conversationId !== binding.childThreadId ||
    approval.runId !== latestTurn.providerRunId
  ) {
    throw new PermissionError("The approval is not pending for an explicitly related child.", 403);
  }
}
