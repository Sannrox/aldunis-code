import type { InteractionMode, WorkspaceMode } from "../types";

export interface WorkspaceModeCopy {
  label: string;
  detail: string;
  shortLabel: string;
}

export const WORKSPACE_MODE_COPY: Record<WorkspaceMode, WorkspaceModeCopy> = {
  shared: {
    label: "Shared checkout",
    shortLabel: "Shared",
    detail: "Use the selected worktree. This is explicit and can be shared by multiple conversations.",
  },
  "aldunis-managed": {
    label: "Aldunis worktree",
    shortLabel: "Aldunis",
    detail: "Create and bind a dedicated Git worktree to this conversation after one approval.",
  },
  "provider-native": {
    label: "Provider-native",
    shortLabel: "Native",
    detail: "Let the selected provider create and own the isolated workspace when its adapter supports that contract.",
  },
};

/** New Build chats default to an Aldunis-owned checkout; read-only modes stay shared. */
export function defaultWorkspaceMode(
  mode: InteractionMode,
  existing: WorkspaceMode | null | undefined,
): WorkspaceMode {
  if (existing) return existing;
  return mode === "build" ? "aldunis-managed" : "shared";
}

export function workspaceModeLabel(mode: WorkspaceMode | null | undefined): string {
  return WORKSPACE_MODE_COPY[mode ?? "shared"].label;
}
