export type WorkbenchRestoreState = "idle" | "loading" | "ready" | "failed";
export type SidebarInboxEmptyMode = "loading" | "failed" | "empty";

/**
 * Split restore and projection sync share one inbox. A later accepted snapshot
 * must unlock Open even if the restore load already failed, and a restore
 * failure must not clobber that recovery.
 */
export function nextRestoreStateAfterProjectionAccept(
  current: WorkbenchRestoreState,
): WorkbenchRestoreState {
  return current === "idle" ? "idle" : "ready";
}

export function nextRestoreStateAfterRestoreFailure(input: {
  current: WorkbenchRestoreState;
  projectionAccepted: boolean;
}): WorkbenchRestoreState {
  if (input.projectionAccepted || input.current === "ready") return "ready";
  return "failed";
}

export function workbenchConversationPanesVisible(input: {
  restoreState: WorkbenchRestoreState;
  hasRepository: boolean;
}): boolean {
  return !input.hasRepository || input.restoreState === "ready";
}

export function sidebarInboxEmptyMode(input: {
  restoreState: WorkbenchRestoreState;
  hasVisibleConversations: boolean;
}): SidebarInboxEmptyMode | null {
  if (input.hasVisibleConversations) return null;
  if (input.restoreState === "loading") return "loading";
  if (input.restoreState === "failed") return "failed";
  return "empty";
}
