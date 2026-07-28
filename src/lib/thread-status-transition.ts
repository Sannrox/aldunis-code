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

function sidebarStatus(status: RestoredTurnStatus): string {
  if (status === "waiting_for_approval") return "pending_approval";
  if (status === "waiting_for_user") return "awaiting_input";
  if (status === "active" || status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "idle";
}

/**
 * A recovered provider stream is observed through state polling, outside the
 * normal send lifecycle. Refresh the inbox whenever that observed turn changes
 * its projected sidebar status so attention grouping cannot remain stale.
 */
export function shouldRefreshAfterRestoredTurn(
  previous: { turnId: string; status: RestoredTurnStatus } | null,
  current: { turnId: string; status: RestoredTurnStatus },
): boolean {
  return previous?.turnId === current.turnId
    && sidebarStatus(previous.status) !== sidebarStatus(current.status);
}
