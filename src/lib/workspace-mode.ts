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

/** The two workspace strategies exposed when creating a conversation. */
export const NEW_CONVERSATION_WORKSPACE_MODES: WorkspaceMode[] = [
  "aldunis-managed",
  "provider-native",
];

/** New conversations default to an Aldunis-owned checkout; native is explicit. */
export function defaultWorkspaceMode(
  _mode: InteractionMode,
  existing: WorkspaceMode | null | undefined,
): WorkspaceMode {
  if (existing) return existing;
  return "aldunis-managed";
}

export function workspaceModeLabel(mode: WorkspaceMode | null | undefined): string {
  return WORKSPACE_MODE_COPY[mode ?? "shared"].label;
}
