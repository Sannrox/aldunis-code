export type RestoredTurnStatus =
  | "active"
  | "idle"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "running"
  | "cancelled";

const ACTIVE_STATUSES = new Set<RestoredTurnStatus>([
  "active",
  "running",
  "waiting_for_approval",
]);

/**
 * A recovered provider stream is observed through state polling, outside the
 * normal send lifecycle. Refresh the inbox exactly when that observed turn
 * leaves an active state so its sidebar projection cannot remain stale.
 */
export function shouldRefreshAfterRestoredTurn(
  previous: { turnId: string; status: RestoredTurnStatus } | null,
  current: { turnId: string; status: RestoredTurnStatus },
): boolean {
  return previous?.turnId === current.turnId
    && ACTIVE_STATUSES.has(previous.status)
    && !ACTIVE_STATUSES.has(current.status);
}
