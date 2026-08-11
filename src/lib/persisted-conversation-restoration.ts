import type {
  ContextPin,
  ContextReceipt,
  InteractionMode,
  ProviderEvent,
  ProviderId,
  ProviderPlanArtifact,
  ProviderState,
  ReasoningEffort,
  TurnCheckpoint,
} from "../types";
import type { RestoredTurnStatus } from "./thread-status-transition";

export interface PersistedConversationProjection {
  threads: Array<{
    id: string;
    projectId: string;
    worktree: string;
    provider?: ProviderId;
    profileId?: string | null;
    model?: string | null;
    reasoningEffort?: ReasoningEffort;
    contextPins?: ContextPin[];
  }>;
  turns: Array<{
    id: string;
    threadId: string;
    status: RestoredTurnStatus;
    mode?: InteractionMode;
    providerRunId?: string;
    createdAt: string;
    completedAt?: string | null;
  }>;
  messages: Array<{
    turnId: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    eventSequence?: number;
  }>;
  activities?: Array<{
    turnId: string;
    kind: "tool_started" | "tool_finished" | "provider_failed";
    toolCallId: string | null;
    name: string | null;
    failed: boolean | null;
    message: string | null;
    createdAt: string;
    eventSequence?: number;
  }>;
  plans?: Array<{
    artifactId: string;
    threadId: string;
    turnId: string;
    provider: ProviderId;
    title?: string;
    body?: string;
    steps?: ProviderPlanArtifact["steps"];
    updatedAt: string;
    createdAt: string;
    eventSequence?: number;
  }>;
  contextReceipts?: ContextReceipt[];
  inputRequests?: Array<Extract<ProviderEvent, { kind: "input_requested" }> & { turnId: string }>;
  providerSessions: Array<{
    threadId: string;
    provider?: ProviderId;
    sessionId: string;
    model?: string | null;
    profileId?: string;
  }>;
  governanceCorrelations?: Array<{
    id: string;
    turnId: string;
    runId: string;
    operationId: string;
    governance: "sekai-chisei";
    createdAt: string;
  }>;
  checkpoints?: TurnCheckpoint[];
}

export interface PersistedConversationTarget {
  conversationId: string | null;
  projectId: string;
  worktree: string;
  activeProvider: ProviderId;
  forcedProvider?: ProviderId;
  providerName: string;
}

export interface RestoredConversationTurn {
  message: { text: string; mode: InteractionMode; createdAt: string };
  events: ProviderEvent[];
  assistantAt: string;
  state: RestoredTurnStatus;
  contextReceipt?: ContextReceipt;
  checkpoint?: TurnCheckpoint;
}

interface RestoredThreadBinding {
  threadId: string;
  provider: ProviderId;
  profileId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  sessionId: string | null;
  attachments: string[];
  folderPins: string[];
}

export type PersistedConversationRestoration =
  | { kind: "thread_missing" }
  | { kind: "provider_changed"; provider: ProviderId }
  | { kind: "empty_thread"; thread: RestoredThreadBinding }
  | {
      kind: "restored";
      thread: RestoredThreadBinding;
      messages: Array<{ text: string; mode: InteractionMode; createdAt: string }>;
      archivedTurns: RestoredConversationTurn[];
      currentTurn: RestoredConversationTurn;
      providerState: ProviderState;
      assistantTurnAt: string;
      latestStatus: { turnId: string; status: RestoredTurnStatus };
      pendingRunId: string | null;
    };

/** Complete normalized identity for suppressing redundant renderer application. */
export function persistedConversationRestorationFingerprint(
  restoration: PersistedConversationRestoration,
): string {
  return JSON.stringify(restoration);
}

export type PersistedRestorationApplication = { target: string; fingerprint: string } | null;

/** Reset on an unbound composer; otherwise decide whether normalized state must be reapplied. */
export function reconcilePersistedRestorationApplication(
  current: PersistedRestorationApplication,
  next: PersistedRestorationApplication,
): { current: PersistedRestorationApplication; apply: boolean } {
  if (!next) return { current: null, apply: false };
  return {
    current: next,
    apply: current?.target !== next.target || current.fingerprint !== next.fingerprint,
  };
}

interface OrderedEvent {
  event: ProviderEvent;
  createdAt: string;
  eventSequence?: number;
  ordinal: number;
}

/**
 * Preserve the exact order among sequenced records, then place legacy or
 * projection-only records into timestamp slots without using a non-transitive
 * mixed comparator. Source ordinal makes equal timestamps deterministic.
 */
function orderEvents(events: OrderedEvent[]): OrderedEvent[] {
  const sequenced = events
    .filter((item) => item.eventSequence !== undefined)
    .sort(
      (left, right) => left.eventSequence! - right.eventSequence! || left.ordinal - right.ordinal,
    );
  const unsequenced = events
    .filter((item) => item.eventSequence === undefined)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.ordinal - right.ordinal,
    );
  const result = [...sequenced];
  for (const item of unsequenced) {
    let index = 0;
    for (let candidate = result.length - 1; candidate >= 0; candidate -= 1) {
      if (result[candidate]!.createdAt <= item.createdAt) {
        index = candidate + 1;
        break;
      }
    }
    while (
      index < result.length &&
      result[index]!.eventSequence === undefined &&
      result[index]!.createdAt === item.createdAt
    ) {
      index += 1;
    }
    result.splice(index, 0, item);
  }
  return result;
}

export function restoredTurnTerminalEvent(
  status: RestoredTurnStatus,
  sessionId: string | null,
): ProviderEvent | null {
  switch (status) {
    case "completed":
      return { kind: "turn_completed", sessionId: sessionId ?? "restored", costUsd: null };
    case "failed":
      return { kind: "failed", message: "Provider failed." };
    case "interrupted":
    case "cancelled":
      return { kind: "cancelled" };
    default:
      return null;
  }
}

function providerStateFor(status: RestoredTurnStatus): ProviderState {
  if (status === "active" || status === "running") return "streaming";
  if (status === "waiting_for_approval") return "waiting_for_approval";
  if (status === "waiting_for_user") return "waiting_for_input";
  if (status === "interrupted" || status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "idle";
}

export function restorePersistedConversation(
  projection: PersistedConversationProjection,
  target: PersistedConversationTarget,
): PersistedConversationRestoration {
  const thread = target.conversationId
    ? projection.threads.find(
        (item) =>
          item.id === target.conversationId &&
          item.projectId === target.projectId &&
          item.worktree === target.worktree,
      )
    : null;
  if (!thread) return { kind: "thread_missing" };

  const provider = target.forcedProvider ?? thread.provider ?? "claude-code";
  if (provider !== target.activeProvider) return { kind: "provider_changed", provider };

  const session = projection.providerSessions.find(
    (item) => item.threadId === thread.id && (item.provider ?? "claude-code") === provider,
  );
  const binding: RestoredThreadBinding = {
    threadId: thread.id,
    provider,
    profileId: thread.profileId || session?.profileId || null,
    model: thread.model || session?.model?.trim() || null,
    reasoningEffort: thread.reasoningEffort ?? null,
    sessionId: session?.sessionId ?? null,
    attachments: (thread.contextPins ?? [])
      .filter((pin) => pin.kind === "file")
      .map((pin) => pin.path),
    folderPins: (thread.contextPins ?? [])
      .filter((pin) => pin.kind === "folder")
      .map((pin) => pin.path),
  };
  const turns = projection.turns
    .filter((item) => item.threadId === thread.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latest = turns.at(-1);
  if (!latest) return { kind: "empty_thread", thread: binding };

  const turnIds = new Set(turns.map((turn) => turn.id));
  const history = projection.messages
    .filter((message) => turnIds.has(message.turnId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const messages = history
    .filter((message) => message.role === "user")
    .map((message) => ({
      text: message.text,
      mode: turns.find((turn) => turn.id === message.turnId)?.mode ?? "ask",
      createdAt: message.createdAt,
    }));

  const eventsForTurn = (turnId: string): OrderedEvent[] => {
    const turn = turns.find((item) => item.id === turnId);
    let ordinal = 0;
    const ordered = orderEvents([
      ...history
        .filter(
          (message) =>
            message.turnId === turnId && message.role === "assistant" && message.text.length > 0,
        )
        .map((message) => ({
          event: { kind: "assistant_text" as const, text: message.text },
          createdAt: message.createdAt,
          eventSequence: message.eventSequence,
          ordinal: ordinal++,
        })),
      ...(projection.activities ?? [])
        .filter((activity) => activity.turnId === turnId)
        .flatMap((activity): OrderedEvent[] => {
          let event: ProviderEvent | null = null;
          if (activity.kind === "provider_failed") {
            event = {
              kind: "failed",
              message: activity.message?.trim() || `${target.providerName} failed.`,
            };
          } else if (activity.kind === "tool_started" && activity.toolCallId) {
            event = {
              kind: "tool_started",
              toolCallId: activity.toolCallId,
              name: activity.name?.trim() || "Tool",
            };
          } else if (activity.kind === "tool_finished" && activity.toolCallId) {
            event = {
              kind: "tool_finished",
              toolCallId: activity.toolCallId,
              failed: activity.failed === true,
            };
          }
          return event
            ? [
                {
                  event,
                  createdAt: activity.createdAt,
                  eventSequence: activity.eventSequence,
                  ordinal: ordinal++,
                },
              ]
            : [];
        }),
      ...(projection.plans ?? [])
        .filter((plan) => plan.turnId === turnId)
        .map((plan) => ({
          event: {
            kind: "plan_updated" as const,
            artifact: {
              id: plan.artifactId,
              provider: plan.provider,
              ...(plan.title !== undefined ? { title: plan.title } : {}),
              ...(plan.body !== undefined ? { body: plan.body } : {}),
              ...(plan.steps !== undefined ? { steps: plan.steps } : {}),
              updatedAt: plan.updatedAt,
            },
          },
          createdAt: plan.createdAt,
          eventSequence: plan.eventSequence,
          ordinal: ordinal++,
        })),
      ...(projection.inputRequests ?? [])
        .filter((request) => request.turnId === turnId)
        .map((request) => ({
          event:
            request.state === "pending"
              ? ({ ...request, kind: "input_requested" as const } satisfies ProviderEvent)
              : ({
                  kind: "input_resolved" as const,
                  id: request.id,
                  state: request.state,
                } satisfies ProviderEvent),
          createdAt: request.createdAt,
          ordinal: ordinal++,
        })),
      ...(projection.governanceCorrelations ?? [])
        .filter((receipt) => receipt.turnId === turnId)
        .map((receipt) => ({
          event: {
            kind: "governance_correlation" as const,
            governance: receipt.governance,
            runId: receipt.runId,
            operationId: receipt.operationId,
            correlationId: receipt.id,
          },
          createdAt: receipt.createdAt,
          ordinal: ordinal++,
        })),
    ]);
    const terminal = turn ? restoredTurnTerminalEvent(turn.status, binding.sessionId) : null;
    if (
      !terminal ||
      ordered.some(
        ({ event }) =>
          event.kind === "turn_completed" || event.kind === "failed" || event.kind === "cancelled",
      )
    ) {
      return ordered;
    }
    return [
      ...ordered,
      {
        event: terminal,
        createdAt: turn?.completedAt ?? ordered.at(-1)?.createdAt ?? turn?.createdAt ?? "",
        ordinal: ordinal++,
      },
    ];
  };

  const restoredTurns = turns.flatMap((turn): RestoredConversationTurn[] => {
    const user = history.find((message) => message.turnId === turn.id && message.role === "user");
    if (!user) return [];
    const orderedEvents = eventsForTurn(turn.id);
    return [
      {
        message: { text: user.text, mode: turn.mode ?? "ask", createdAt: user.createdAt },
        events: orderedEvents.map(({ event }) => event),
        assistantAt: turn.completedAt ?? orderedEvents.at(-1)?.createdAt ?? turn.createdAt,
        state: turn.status,
        contextReceipt: projection.contextReceipts?.find((receipt) => receipt.turnId === turn.id),
        checkpoint: projection.checkpoints?.find((checkpoint) => checkpoint.turnId === turn.id),
      },
    ];
  });
  const currentTurn = restoredTurns.at(-1);
  if (!currentTurn) return { kind: "empty_thread", thread: binding };
  const lastAssistantAt = history
    .filter((message) => message.role === "assistant" && message.createdAt)
    .at(-1)?.createdAt;
  const pendingRunId =
    latest.providerRunId &&
    (latest.status === "active" ||
      latest.status === "running" ||
      latest.status === "waiting_for_approval")
      ? latest.providerRunId
      : null;
  return {
    kind: "restored",
    thread: binding,
    messages,
    archivedTurns: restoredTurns.slice(0, -1),
    currentTurn,
    providerState: providerStateFor(latest.status),
    assistantTurnAt: latest.completedAt ?? lastAssistantAt ?? latest.createdAt,
    latestStatus: { turnId: latest.id, status: latest.status },
    pendingRunId,
  };
}
