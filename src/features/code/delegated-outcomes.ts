import type {
  ConversationSummary,
  DelegatedConversationRelationship,
} from "../../types";
import type { RestoredTurnStatus } from "../../lib/thread-status-transition";

export interface DelegatedOutcome {
  relationship: DelegatedConversationRelationship;
  child: ConversationSummary;
}

export interface DelegatedOutcomeSummary {
  outcomes: DelegatedOutcome[];
  running: number;
  approvals: number;
  inputs: number;
  failures: number;
  completed: number;
}

export function summarizeDelegatedOutcomes(
  parentThreadId: string,
  conversations: ConversationSummary[],
  relationships: DelegatedConversationRelationship[],
): DelegatedOutcomeSummary {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const outcomes = relationships
    .filter((relationship) => relationship.parentThreadId === parentThreadId)
    .map((relationship) => {
      const child = byId.get(relationship.childThreadId);
      return child ? { relationship, child } : null;
    })
    .filter((outcome): outcome is DelegatedOutcome => outcome !== null)
    .sort((left, right) => (
      left.relationship.createdAt.localeCompare(right.relationship.createdAt)
      || left.relationship.id.localeCompare(right.relationship.id)
    ));

  return {
    outcomes,
    running: outcomes.filter(({ child }) => child.status === "running").length,
    approvals: outcomes.filter(({ child }) => child.status === "pending_approval").length,
    inputs: outcomes.filter(({ child }) => child.status === "awaiting_input").length,
    failures: outcomes.filter(({ child }) => child.status === "failed").length,
    completed: outcomes.filter(({ child }) => child.status === "completed").length,
  };
}

export function isQuietDelegatedChild(
  childThreadId: string | null,
  focusedParentThreadId: string | null,
  relationships: DelegatedConversationRelationship[],
): boolean {
  if (!childThreadId || !focusedParentThreadId) return false;
  return relationships.some((relationship) => (
    relationship.parentThreadId === focusedParentThreadId
    && relationship.childThreadId === childThreadId
  ));
}

export function shouldNotifyForRestoredTurn(
  status: RestoredTurnStatus,
  notificationsEnabled: boolean,
  visibilityState: DocumentVisibilityState,
  quietDelegatedChild: boolean,
): boolean {
  if (!notificationsEnabled || visibilityState === "visible") return false;
  const eligible = quietDelegatedChild
    ? ["waiting_for_approval", "waiting_for_user", "failed"]
    : ["waiting_for_approval", "completed", "failed", "interrupted"];
  return eligible.includes(status);
}
