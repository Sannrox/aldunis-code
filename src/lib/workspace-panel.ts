export const WORKSPACE_PANEL_DESTINATIONS = ["files", "preview", "changes"] as const;

export type WorkspacePanelDestination = (typeof WORKSPACE_PANEL_DESTINATIONS)[number];
export type WorkspacePanel = "none" | WorkspacePanelDestination;

export function toggleWorkspacePanel(
  current: WorkspacePanel,
  destination: WorkspacePanelDestination,
): WorkspacePanel {
  return current === destination ? "none" : destination;
}

export function workspacePanelTabStop(
  active: WorkspacePanel,
  available: readonly WorkspacePanelDestination[],
  focused: WorkspacePanelDestination | null = null,
): WorkspacePanelDestination | null {
  if (focused && available.includes(focused)) return focused;
  if (active !== "none" && available.includes(active)) return active;
  return available[0] ?? null;
}

export function moveWorkspacePanelFocus(
  current: WorkspacePanelDestination,
  direction: "first" | "last" | "next" | "previous",
  available: readonly WorkspacePanelDestination[],
): WorkspacePanelDestination | null {
  if (available.length === 0) return null;
  if (direction === "first") return available[0] ?? null;
  if (direction === "last") return available.at(-1) ?? null;
  const currentIndex = available.indexOf(current);
  const start = currentIndex < 0 ? 0 : currentIndex;
  const offset = direction === "next" ? 1 : -1;
  return available[(start + offset + available.length) % available.length] ?? null;
}
