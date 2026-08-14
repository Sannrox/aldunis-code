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
  sequence: number;
  threads: Array<{
    id: string;
    projectId: string;
    worktree: string;
    title?: string;
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
  mailboxTransfers?: Array<{
    id: string;
    sourceThreadId: string;
    destinationThreadId: string;
    text: string;
    createdAt: string;
    destinationTurnId: string | null;
  }>;
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

export interface RestoredMailboxOutbound {
  id: string;
  destinationTitle: string;
  text: string;
  createdAt: string;
}

export interface RestoredConversationTurn {
  message: { text: string; mode: InteractionMode; createdAt: string };
  events: ProviderEvent[];
  assistantAt: string;
  state: RestoredTurnStatus;
  contextReceipt?: ContextReceipt;
  checkpoint?: TurnCheckpoint;
  mailboxFrom?: string | null;
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
  | { kind: "empty_thread"; thread: RestoredThreadBinding; mailboxOutbound: RestoredMailboxOutbound[] }
  | {
      kind: "restored";
      thread: RestoredThreadBinding;
      messages: Array<{ text: string; mode: InteractionMode; createdAt: string }>;
      archivedTurns: RestoredConversationTurn[];
      currentTurn: RestoredConversationTurn;
      mailboxOutbound: RestoredMailboxOutbound[];
      providerState: ProviderState;
      assistantTurnAt: string;
      latestStatus: { turnId: string; status: RestoredTurnStatus };
      pendingRunId: string | null;
    };

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

interface RestorationSourceRecord {
  createdAt: string;
  eventSequence?: number;
}

interface RestorationEventSource {
  length: number;
  sequencedLength: number;
  createdAt(index: number): string;
  eventSequence(index: number): number | undefined;
  event(index: number): ProviderEvent;
}

function groupByTurnId<T extends { turnId: string }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const group = grouped.get(item.turnId);
    if (group) group.push(item);
    else grouped.set(item.turnId, [item]);
  }
  return grouped;
}

function compareRestorationRecords(
  left: RestorationSourceRecord,
  right: RestorationSourceRecord,
): number {
  const leftSequence = left.eventSequence;
  const rightSequence = right.eventSequence;
  if (leftSequence !== undefined && rightSequence !== undefined) {
    return leftSequence - rightSequence;
  }
  if (leftSequence !== undefined) return -1;
  if (rightSequence !== undefined) return 1;
  return left.createdAt.localeCompare(right.createdAt);
}

function sortRestorationSource<T extends RestorationSourceRecord>(items: T[]): T[] {
  for (let index = 1; index < items.length; index += 1) {
    if (compareRestorationRecords(items[index - 1]!, items[index]!) > 0) {
      return items.sort(compareRestorationRecords);
    }
  }
  return items;
}

function restorationEventSource<T extends RestorationSourceRecord>(
  records: T[],
  event: (record: T) => ProviderEvent,
): RestorationEventSource {
  const items = sortRestorationSource(records);
  const sequencedLength = items.findIndex((item) => item.eventSequence === undefined);
  return {
    length: items.length,
    sequencedLength: sequencedLength < 0 ? items.length : sequencedLength,
    createdAt: (index) => items[index]!.createdAt,
    eventSequence: (index) => items[index]!.eventSequence,
    event: (index) => event(items[index]!),
  };
}

function nextSequencedSource(
  sources: readonly RestorationEventSource[],
  cursors: readonly number[],
): number {
  let selected = -1;
  for (let source = 0; source < sources.length; source += 1) {
    const candidate = sources[source]!;
    if (cursors[source]! >= candidate.sequencedLength) continue;
    if (selected < 0) {
      selected = source;
      continue;
    }
    const sequence = candidate.eventSequence(cursors[source]!)!;
    const selectedSequence = sources[selected]!.eventSequence(cursors[selected]!)!;
    if (sequence < selectedSequence) selected = source;
  }
  return selected;
}

function nextUnsequencedSource(
  sources: readonly RestorationEventSource[],
  cursors: readonly number[],
): number {
  let selected = -1;
  for (let source = 0; source < sources.length; source += 1) {
    const candidate = sources[source]!;
    if (cursors[source]! >= candidate.length) continue;
    if (selected < 0) {
      selected = source;
      continue;
    }
    if (candidate.createdAt(cursors[source]!) < sources[selected]!.createdAt(cursors[selected]!)) {
      selected = source;
    }
  }
  return selected;
}

function insertionSlot(suffixMinimumCreatedAt: readonly string[], createdAt: string): number {
  let low = 0;
  let high = suffixMinimumCreatedAt.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (suffixMinimumCreatedAt[middle]! <= createdAt) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Preserve sequence order, then directly emit timestamp-slotted legacy and
 * projection-only events. Only one string reference per sequenced event is
 * retained while deriving insertion slots; no combined event wrapper graph is
 * materialized.
 */
function emitRestorationEvents(sources: readonly RestorationEventSource[]): {
  events: ProviderEvent[];
  lastCreatedAt: string | null;
} {
  const sequenceCursors = sources.map(() => 0);
  if (sources.every((source) => source.length === source.sequencedLength)) {
    const events: ProviderEvent[] = [];
    let lastCreatedAt: string | null = null;
    while (true) {
      const sourceIndex = nextSequencedSource(sources, sequenceCursors);
      if (sourceIndex < 0) return { events, lastCreatedAt };
      const source = sources[sourceIndex]!;
      const index = sequenceCursors[sourceIndex]!;
      events.push(source.event(index));
      lastCreatedAt = source.createdAt(index);
      sequenceCursors[sourceIndex] = index + 1;
    }
  }
  const suffixMinimumCreatedAt: string[] = [];
  while (true) {
    const source = nextSequencedSource(sources, sequenceCursors);
    if (source < 0) break;
    const index = sequenceCursors[source]!;
    suffixMinimumCreatedAt.push(sources[source]!.createdAt(index));
    sequenceCursors[source] = index + 1;
  }
  for (let index = suffixMinimumCreatedAt.length - 2; index >= 0; index -= 1) {
    if (suffixMinimumCreatedAt[index + 1]! < suffixMinimumCreatedAt[index]!) {
      suffixMinimumCreatedAt[index] = suffixMinimumCreatedAt[index + 1]!;
    }
  }

  sequenceCursors.fill(0);
  const unsequencedCursors = sources.map((source) => source.sequencedLength);
  const events: ProviderEvent[] = [];
  let lastCreatedAt: string | null = null;
  let unsequencedSource = nextUnsequencedSource(sources, unsequencedCursors);

  for (let slot = 0; slot <= suffixMinimumCreatedAt.length; slot += 1) {
    while (unsequencedSource >= 0) {
      const source = sources[unsequencedSource]!;
      const index = unsequencedCursors[unsequencedSource]!;
      const createdAt = source.createdAt(index);
      if (insertionSlot(suffixMinimumCreatedAt, createdAt) !== slot) break;
      events.push(source.event(index));
      lastCreatedAt = createdAt;
      unsequencedCursors[unsequencedSource] = index + 1;
      unsequencedSource = nextUnsequencedSource(sources, unsequencedCursors);
    }
    if (slot === suffixMinimumCreatedAt.length) break;
    const sourceIndex = nextSequencedSource(sources, sequenceCursors);
    const source = sources[sourceIndex]!;
    const index = sequenceCursors[sourceIndex]!;
    events.push(source.event(index));
    lastCreatedAt = source.createdAt(index);
    sequenceCursors[sourceIndex] = index + 1;
  }
  return { events, lastCreatedAt };
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
  const mailboxOutbound = (projection.mailboxTransfers ?? [])
    .filter((transfer) => transfer.sourceThreadId === thread.id)
    .map((transfer) => ({
      id: transfer.id,
      destinationTitle:
        projection.threads.find((item) => item.id === transfer.destinationThreadId)?.title ??
        "Conversation",
      text: transfer.text,
      createdAt: transfer.createdAt,
    }));
  const mailboxFromByTurn = new Map(
    (projection.mailboxTransfers ?? [])
      .filter((transfer) => transfer.destinationThreadId === thread.id && transfer.destinationTurnId)
      .map((transfer) => [
        transfer.destinationTurnId!,
        projection.threads.find((item) => item.id === transfer.sourceThreadId)?.title ??
          "Conversation",
      ]),
  );
  const latest = turns.at(-1);
  if (!latest) return { kind: "empty_thread", thread: binding, mailboxOutbound };

  const turnIds = new Set(turns.map((turn) => turn.id));
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const history = projection.messages
    .filter((message) => turnIds.has(message.turnId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const messagesByTurn = groupByTurnId(history);
  const activitiesByTurn = groupByTurnId(projection.activities ?? []);
  const plansByTurn = groupByTurnId(projection.plans ?? []);
  const inputRequestsByTurn = groupByTurnId(projection.inputRequests ?? []);
  const correlationsByTurn = groupByTurnId(projection.governanceCorrelations ?? []);
  const contextReceiptsByTurn = groupByTurnId(
    (projection.contextReceipts ?? []).filter(
      (receipt): receipt is ContextReceipt & { turnId: string } =>
        typeof receipt.turnId === "string",
    ),
  );
  const checkpointsByTurn = groupByTurnId(projection.checkpoints ?? []);
  const messages = history
    .filter((message) => message.role === "user")
    .map((message) => ({
      text: message.text,
      mode: turnById.get(message.turnId)?.mode ?? "ask",
      createdAt: message.createdAt,
    }));

  const eventsForTurn = (
    turnId: string,
  ): { events: ProviderEvent[]; lastCreatedAt: string | null } => {
    const turn = turnById.get(turnId);
    const messageSource = restorationEventSource(
      (messagesByTurn.get(turnId) ?? []).filter(
        (message) => message.role === "assistant" && message.text.length > 0,
      ),
      (message) => ({ kind: "assistant_text", text: message.text }),
    );
    const activitySource = restorationEventSource(
      (activitiesByTurn.get(turnId) ?? []).filter(
        (activity) =>
          activity.kind === "provider_failed" ||
          ((activity.kind === "tool_started" || activity.kind === "tool_finished") &&
            Boolean(activity.toolCallId)),
      ),
      (activity): ProviderEvent => {
        if (activity.kind === "provider_failed") {
          return {
            kind: "failed",
            message: activity.message?.trim() || `${target.providerName} failed.`,
          };
        }
        if (activity.kind === "tool_started") {
          return {
            kind: "tool_started",
            toolCallId: activity.toolCallId!,
            name: activity.name?.trim() || "Tool",
          };
        }
        return {
          kind: "tool_finished",
          toolCallId: activity.toolCallId!,
          failed: activity.failed === true,
        };
      },
    );
    const planSource = restorationEventSource(plansByTurn.get(turnId) ?? [], (plan) => ({
      kind: "plan_updated",
      artifact: {
        id: plan.artifactId,
        provider: plan.provider,
        ...(plan.title !== undefined ? { title: plan.title } : {}),
        ...(plan.body !== undefined ? { body: plan.body } : {}),
        ...(plan.steps !== undefined ? { steps: plan.steps } : {}),
        updatedAt: plan.updatedAt,
      },
    }));
    const inputSource = restorationEventSource(inputRequestsByTurn.get(turnId) ?? [], (request) =>
      request.state === "pending"
        ? ({ ...request, kind: "input_requested" as const } satisfies ProviderEvent)
        : ({
            kind: "input_resolved" as const,
            id: request.id,
            state: request.state,
          } satisfies ProviderEvent),
    );
    const correlationSource = restorationEventSource(
      correlationsByTurn.get(turnId) ?? [],
      (receipt) => ({
        kind: "governance_correlation",
        governance: receipt.governance,
        runId: receipt.runId,
        operationId: receipt.operationId,
        correlationId: receipt.id,
      }),
    );
    const ordered = emitRestorationEvents([
      messageSource,
      activitySource,
      planSource,
      inputSource,
      correlationSource,
    ]);
    const terminal = turn ? restoredTurnTerminalEvent(turn.status, binding.sessionId) : null;
    if (
      !terminal ||
      ordered.events.some(
        (event) =>
          event.kind === "turn_completed" || event.kind === "failed" || event.kind === "cancelled",
      )
    ) {
      return ordered;
    }
    const terminalCreatedAt = turn?.completedAt ?? ordered.lastCreatedAt ?? turn?.createdAt ?? "";
    ordered.events.push(terminal);
    return { events: ordered.events, lastCreatedAt: terminalCreatedAt };
  };

  const restoredTurns = turns.flatMap((turn): RestoredConversationTurn[] => {
    const user = messagesByTurn.get(turn.id)?.find((message) => message.role === "user");
    if (!user) return [];
    const orderedEvents = eventsForTurn(turn.id);
    return [
      {
        message: { text: user.text, mode: turn.mode ?? "ask", createdAt: user.createdAt },
        events: orderedEvents.events,
        assistantAt: turn.completedAt ?? orderedEvents.lastCreatedAt ?? turn.createdAt,
        state: turn.status,
        contextReceipt: contextReceiptsByTurn.get(turn.id)?.[0],
        checkpoint: checkpointsByTurn.get(turn.id)?.[0],
        mailboxFrom: mailboxFromByTurn.get(turn.id) ?? null,
      },
    ];
  });
  const currentTurn = restoredTurns.at(-1);
  if (!currentTurn) return { kind: "empty_thread", thread: binding, mailboxOutbound };
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
    mailboxOutbound,
    providerState: providerStateFor(latest.status),
    assistantTurnAt: latest.completedAt ?? lastAssistantAt ?? latest.createdAt,
    latestStatus: { turnId: latest.id, status: latest.status },
    pendingRunId,
  };
}
