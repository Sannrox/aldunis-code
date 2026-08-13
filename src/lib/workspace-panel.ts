import type { ChangedFile, TurnCheckpoint } from "../types";

export const WORKSPACE_PANEL_DESTINATIONS = ["files", "preview", "changes"] as const;

export type WorkspacePanelDestination = (typeof WORKSPACE_PANEL_DESTINATIONS)[number];
export type WorkspacePanel = "none" | WorkspacePanelDestination;
export type WorkspacePanelDirection = "first" | "last" | "next" | "previous";
export type WorkspaceChangesMode = "review" | "deliver";

export interface WorkspaceTurnReview {
  checkpointId: string;
  files: ChangedFile[];
}

export interface WorkspacePanelLifecycleState {
  activePanel: WorkspacePanel;
  focusedPanel: WorkspacePanelDestination | null;
  previewMounted: boolean;
  previewFloating: boolean;
  browserObservationOpen: boolean;
  changesMode: WorkspaceChangesMode;
  turnReview: WorkspaceTurnReview | null;
}

export type WorkspacePanelLifecycleEvent =
  | { type: "sync_active"; panel: WorkspacePanel }
  | { type: "toggle"; destination: WorkspacePanelDestination }
  | { type: "open_changes"; mode: WorkspaceChangesMode }
  | { type: "open_turn_changes"; checkpoint: TurnCheckpoint }
  | { type: "signal_changes"; mode: WorkspaceChangesMode }
  | { type: "set_changes_mode"; mode: WorkspaceChangesMode }
  | { type: "close"; destination: WorkspacePanelDestination; restoreFocus?: boolean }
  | { type: "close_preview" }
  | { type: "dismiss_preview" }
  | { type: "toggle_preview_floating" }
  | { type: "browser_observation"; present: boolean }
  | { type: "workspace_reset" }
  | { type: "conversation_reset" }
  | {
      type: "move_focus";
      from: WorkspacePanelDestination;
      direction: WorkspacePanelDirection;
      available: readonly WorkspacePanelDestination[];
    };

export type WorkspacePanelLifecycleEffect =
  | { type: "change_panel"; panel: WorkspacePanel }
  | { type: "refresh_changes" }
  | { type: "focus_panel"; destination: WorkspacePanelDestination; defer: boolean };

export interface WorkspacePanelLifecycleTransition {
  state: WorkspacePanelLifecycleState;
  effects: WorkspacePanelLifecycleEffect[];
}

export function initialWorkspacePanelLifecycle(
  activePanel: WorkspacePanel = "none",
): WorkspacePanelLifecycleState {
  return {
    activePanel,
    focusedPanel: null,
    previewMounted: false,
    previewFloating: false,
    browserObservationOpen: false,
    changesMode: "review",
    turnReview: null,
  };
}

export function workspacePanelTabStop(
  state: Pick<WorkspacePanelLifecycleState, "activePanel" | "focusedPanel">,
  available: readonly WorkspacePanelDestination[],
): WorkspacePanelDestination | null {
  if (state.focusedPanel && available.includes(state.focusedPanel)) return state.focusedPanel;
  if (state.activePanel !== "none" && available.includes(state.activePanel)) {
    return state.activePanel;
  }
  return available[0] ?? null;
}

function movedFocus(
  current: WorkspacePanelDestination,
  direction: WorkspacePanelDirection,
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

export function transitionWorkspacePanelLifecycle(
  current: WorkspacePanelLifecycleState,
  event: WorkspacePanelLifecycleEvent,
): WorkspacePanelLifecycleTransition {
  if (event.type === "sync_active") {
    return { state: { ...current, activePanel: event.panel }, effects: [] };
  }
  if (event.type === "toggle") {
    const activePanel = current.activePanel === event.destination ? "none" : event.destination;
    const previewFloating = event.destination === "preview" ? false : current.previewFloating;
    return {
      state: {
        ...current,
        activePanel,
        focusedPanel: event.destination,
        previewFloating,
        previewMounted: activePanel === "preview" || previewFloating,
      },
      effects: [
        ...(activePanel === "changes" && current.activePanel !== "changes"
          ? ([{ type: "refresh_changes" }] as const)
          : []),
        { type: "change_panel", panel: activePanel },
      ],
    };
  }
  if (event.type === "open_changes") {
    const opening = current.activePanel !== "changes";
    return {
      state: {
        ...current,
        activePanel: "changes",
        focusedPanel: "changes",
        changesMode: event.mode,
        turnReview: null,
      },
      effects: [
        { type: "refresh_changes" },
        ...(opening ? ([{ type: "change_panel", panel: "changes" }] as const) : []),
      ],
    };
  }
  if (event.type === "open_turn_changes") {
    if (
      (event.checkpoint.state !== "completed" && event.checkpoint.state !== "superseded") ||
      !event.checkpoint.files?.length
    ) {
      return { state: current, effects: [] };
    }
    const opening = current.activePanel !== "changes";
    return {
      state: {
        ...current,
        activePanel: "changes",
        focusedPanel: "changes",
        changesMode: "review",
        turnReview: {
          checkpointId: event.checkpoint.id,
          files: event.checkpoint.files,
        },
      },
      effects: opening ? [{ type: "change_panel", panel: "changes" }] : [],
    };
  }
  if (event.type === "signal_changes") {
    return {
      state: { ...current, changesMode: event.mode, turnReview: null },
      effects: [],
    };
  }
  if (event.type === "set_changes_mode") {
    return { state: { ...current, changesMode: event.mode }, effects: [] };
  }
  if (event.type === "close" || event.type === "close_preview") {
    const destination = event.type === "close_preview" ? "preview" : event.destination;
    if (current.activePanel !== destination) {
      const state =
        event.type === "close_preview"
          ? {
              ...current,
              previewMounted: false,
              previewFloating: false,
              browserObservationOpen: false,
            }
          : current;
      return { state, effects: [] };
    }
    const restoreFocus = event.type === "close_preview" || event.restoreFocus !== false;
    return {
      state: {
        ...current,
        activePanel: "none",
        previewMounted: destination === "preview" ? false : current.previewMounted,
        previewFloating: destination === "preview" ? false : current.previewFloating,
        browserObservationOpen: destination === "preview" ? false : current.browserObservationOpen,
        turnReview: destination === "changes" ? null : current.turnReview,
      },
      effects: [
        { type: "change_panel", panel: "none" },
        ...(restoreFocus ? ([{ type: "focus_panel", destination, defer: true }] as const) : []),
      ],
    };
  }
  if (event.type === "dismiss_preview") {
    return {
      state: {
        ...current,
        activePanel: current.activePanel === "preview" ? "none" : current.activePanel,
        previewMounted: false,
        previewFloating: false,
        browserObservationOpen: false,
      },
      effects: [
        ...(current.activePanel === "preview"
          ? ([{ type: "change_panel", panel: "none" }] as const)
          : []),
        { type: "focus_panel", destination: "preview", defer: true },
      ],
    };
  }
  if (event.type === "toggle_preview_floating") {
    if (current.previewFloating) {
      return {
        state: { ...current, activePanel: "preview", previewFloating: false },
        effects: [{ type: "change_panel", panel: "preview" }],
      };
    }
    return {
      state: {
        ...current,
        activePanel: current.activePanel === "preview" ? "none" : current.activePanel,
        previewMounted: true,
        previewFloating: true,
      },
      effects: current.activePanel === "preview" ? [{ type: "change_panel", panel: "none" }] : [],
    };
  }
  if (event.type === "browser_observation") {
    return {
      state: event.present
        ? {
            ...current,
            previewMounted: true,
            previewFloating: true,
            browserObservationOpen: true,
          }
        : { ...current, browserObservationOpen: false },
      effects: [],
    };
  }
  if (event.type === "workspace_reset") {
    return {
      state: {
        ...current,
        previewMounted: false,
        previewFloating: false,
        browserObservationOpen: false,
      },
      effects: [],
    };
  }
  if (event.type === "conversation_reset") {
    return { state: { ...current, turnReview: null }, effects: [] };
  }
  const focusedPanel = movedFocus(event.from, event.direction, event.available);
  return {
    state: { ...current, focusedPanel },
    effects: focusedPanel ? [{ type: "focus_panel", destination: focusedPanel, defer: false }] : [],
  };
}
