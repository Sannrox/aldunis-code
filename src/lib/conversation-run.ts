import type { ProviderEvent, ProviderState } from "../types";
import { contextWindowFromUsage, type ContextWindowSnapshot } from "./context-window";

export interface ConversationRunState {
  epoch: number;
  events: ProviderEvent[];
  providerState: ProviderState;
  contextUsage: ContextWindowSnapshot | null;
  sessionId: string | null;
  assistantTurnAt: string | null;
}

export type ConversationRunAction =
  | { type: "reset"; epoch: number }
  | { type: "clear_context" }
  | { type: "start"; epoch: number }
  | { type: "stream_opened"; epoch: number }
  | { type: "provider_event"; epoch: number; event: ProviderEvent; occurredAt: string }
  | { type: "transport_failed"; epoch: number; message: string; occurredAt: string }
  | { type: "interaction_failed"; message: string }
  | { type: "cancel_requested" }
  | {
      type: "approval_decided";
      id: string;
      state: Extract<ProviderEvent, { kind: "approval_pending" }>["state"];
    }
  | {
      type: "approvals_restored";
      approvals: Array<Extract<ProviderEvent, { kind: "approval_pending" }>>;
    }
  | { type: "input_answered"; id: string }
  | {
      type: "restore";
      events: ProviderEvent[];
      providerState: ProviderState;
      sessionId: string | null;
      assistantTurnAt: string | null;
    };

export function initialConversationRunState(): ConversationRunState {
  return {
    epoch: 0,
    events: [],
    providerState: "idle",
    contextUsage: null,
    sessionId: null,
    assistantTurnAt: null,
  };
}

function appendProviderEvent(current: ProviderEvent[], next: ProviderEvent): ProviderEvent[] {
  if (next.kind !== "browser_observation") return [...current, next];
  let replaced = false;
  const result: ProviderEvent[] = [];
  for (const event of current) {
    if (event.kind !== "browser_observation") result.push(event);
    else if (!replaced) {
      result.push(next);
      replaced = true;
    }
  }
  if (!replaced) result.push(next);
  return result;
}

function preserveInputResolution(
  current: ProviderEvent[],
  resolution: Extract<ProviderEvent, { kind: "input_resolved" }>,
): ProviderEvent[] {
  let inserted = false;
  const result: ProviderEvent[] = [];
  for (const event of current) {
    if (
      (event.kind === "input_requested" || event.kind === "input_resolved") &&
      event.id === resolution.id
    ) {
      if (!inserted) {
        result.push(resolution);
        inserted = true;
      }
      continue;
    }
    result.push(event);
  }
  if (!inserted) result.push(resolution);
  return result;
}

function closePendingApprovals(events: ProviderEvent[], state: "cancelled" | "provider_failed") {
  return events.map((event) =>
    event.kind === "approval_pending" && event.state === "pending" ? { ...event, state } : event,
  );
}

export function reduceConversationRun(
  state: ConversationRunState,
  action: ConversationRunAction,
): ConversationRunState {
  if (action.type === "reset") return { ...initialConversationRunState(), epoch: action.epoch };
  if (action.type === "clear_context") return { ...state, contextUsage: null };
  if (action.type === "start") {
    return { ...initialConversationRunState(), epoch: action.epoch, providerState: "starting" };
  }
  if (action.type === "stream_opened") {
    return action.epoch === state.epoch ? { ...state, providerState: "streaming" } : state;
  }
  if (action.type === "restore") {
    return {
      ...state,
      events: action.events,
      providerState: action.providerState,
      sessionId: action.sessionId,
      assistantTurnAt: action.assistantTurnAt,
      contextUsage: null,
    };
  }
  if (action.type === "cancel_requested") return { ...state, providerState: "cancelling" };
  if (action.type === "approval_decided") {
    return {
      ...state,
      events: state.events.map((event) =>
        event.kind === "approval_pending" && event.id === action.id
          ? { ...event, state: action.state }
          : event,
      ),
    };
  }
  if (action.type === "approvals_restored") {
    return {
      ...state,
      events: [
        ...state.events.filter((event) => event.kind !== "approval_pending"),
        ...action.approvals,
      ],
    };
  }
  if (action.type === "input_answered") {
    return {
      ...state,
      events: preserveInputResolution(state.events, {
        kind: "input_resolved",
        id: action.id,
        state: "answered",
      }),
      providerState: "streaming",
    };
  }
  if (action.type === "interaction_failed") {
    return { ...state, events: [...state.events, { kind: "failed", message: action.message }] };
  }
  if (action.epoch !== state.epoch) return state;
  if (action.type === "transport_failed") {
    return {
      ...state,
      events: [...state.events, { kind: "failed", message: action.message }],
      providerState: "failed",
      assistantTurnAt: action.occurredAt,
    };
  }

  const event = action.event;
  if (event.kind === "context_usage")
    return { ...state, contextUsage: contextWindowFromUsage(event) };
  if (event.kind === "approval_resolved") {
    return reduceConversationRun(state, {
      type: "approval_decided",
      id: event.id,
      state: event.state,
    });
  }
  if (event.kind === "input_resolved") {
    return {
      ...state,
      events: preserveInputResolution(state.events, event),
      providerState: "streaming",
    };
  }

  let events = appendProviderEvent(state.events, event);
  let providerState = state.providerState;
  let sessionId = state.sessionId;
  let assistantTurnAt = state.assistantTurnAt;
  if (event.kind === "input_requested") providerState = "waiting_for_input";
  if (event.kind === "session_started" || event.kind === "turn_completed")
    sessionId = event.sessionId;
  if (event.kind === "turn_completed") {
    providerState = "completed";
    assistantTurnAt = action.occurredAt;
  } else if (event.kind === "cancelled") {
    events = closePendingApprovals(events, "cancelled");
    providerState = "cancelled";
    assistantTurnAt = action.occurredAt;
  } else if (event.kind === "failed") {
    events = closePendingApprovals(events, "provider_failed");
    providerState = "failed";
    assistantTurnAt = action.occurredAt;
  }
  return { ...state, events, providerState, sessionId, assistantTurnAt };
}

export { appendProviderEvent, preserveInputResolution };
