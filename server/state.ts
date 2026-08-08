import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import { joinAssistantTextChunks } from "../src/lib/assistant-text.ts";
import { wouldCreateDelegatedConversationCycle } from "../src/lib/delegated-conversation-graph.ts";
import {
  type InteractionMode,
  persistedProviderFailureMessage,
  type ProviderEvent,
  type ProviderId,
  type ProviderPlanStep,
  type ReasoningEffort,
} from "./provider.ts";
import type { AutomationFire, AutomationFireKey, AutomationFireStatus } from "./automations.ts";
import {
  parseAutonomyFlow,
  parseAutonomyHook,
  parseAutonomyRun,
  parseAutonomyTask,
  parseHeartbeatMonitor,
  parseStandingOrder,
  type AutonomyFlow,
  type AutonomyHook,
  type AutonomyRun,
  type AutonomyTask,
  type HeartbeatMonitor,
  type StandingOrder,
} from "./autonomy.ts";
import type { ContextPin, ContextReceiptEntry } from "./context.ts";
import type { WorkspaceMode } from "../src/types.ts";

export const LOCAL_STATE_SCHEMA_VERSION = 2;
/** Schema versions accepted when loading on-disk history. */
const SUPPORTED_LOCAL_STATE_SCHEMA_VERSIONS = new Set([1, LOCAL_STATE_SCHEMA_VERSION]);
export const MAX_THREADS_PER_PROJECT = 200;

export interface Project {
  schemaVersion: 2;
  id: string;
  name: string;
  root: string;
  openedAt: string;
  chiseiNamespace?: string | null;
}

export interface Thread {
  schemaVersion: 2;
  id: string;
  projectId: string;
  title: string;
  worktree: string;
  workspaceMode: WorkspaceMode;
  provider: ProviderId;
  parentThreadId?: string;
  forkId?: string;
  profileId?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  /** Sidebar settle (reversible). Distinct from archivedAt. */
  settledAt?: string | null;
  /** Temporary inbox hide until this ISO time. Visibility only; never releases worktrees. */
  snoozedUntil?: string | null;
  /** When the operator last snoozed this conversation. */
  snoozedAt?: string | null;
  /** When the thread last entered a state that wants operator attention. */
  wokeAt?: string | null;
  /** When the operator last opened this thread. Unread is lastVisitedAt < wokeAt. */
  lastVisitedAt?: string | null;
  contextPins?: ContextPin[];
}

export type ConversationDeletionStatus = "pending" | "failed" | "completed";

export interface ConversationDeletion {
  schemaVersion: 2;
  threadId: string;
  status: ConversationDeletionStatus;
  affectedRecords: {
    thread: number;
    turns: number;
    messages: number;
    activities: number;
    plans: number;
    contextReceipts: number;
    governanceCorrelations: number;
    providerSessions: number;
    checkpoints: number;
    annotations: number;
    fileReviews: number;
    forks: number;
    delegatedRelationships: number;
    inputRequests: number;
    inputReceipts: number;
  };
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface DelegatedConversationRelationship {
  schemaVersion: 2;
  id: string;
  parentThreadId: string;
  childThreadId: string;
  createdAt: string;
}

export interface ChildInputRequest {
  schemaVersion: 2;
  id: string;
  threadId: string;
  turnId: string;
  providerRunId: string;
  question: string;
  choices: Array<{ id: string; label: string; description: string | null }>;
  recommendation: string | null;
  responseMode: "native_resume" | "child_follow_up";
  providerRequestId: string | null;
  expiresAt: string | null;
  allowFreeForm: boolean;
  /** Shikigami parked-run lifecycle; absent for other native providers. */
  resumeState?: "available" | "starting" | "claimed" | "started" | "unavailable";
  /** Repository-owned explanation when native resume is no longer available. */
  resumeError?: string | null;
  state: "pending" | "answered" | "cancelled";
  createdAt: string;
  answeredAt: string | null;
}

export interface ChildInputReceipt {
  schemaVersion: 2;
  id: string;
  requestId: string;
  childThreadId: string;
  parentThreadId: string | null;
  answerDigest: string;
  route: "native_resume" | "child_follow_up";
  createdAt: string;
}

export interface ForkTransferMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface ForkTransferAnnotation {
  id: string;
  path: string;
  text: string;
  capturedContext: string;
}

export interface ConversationFork {
  schemaVersion: 2;
  id: string;
  sourceThreadId: string;
  destinationThreadId: string;
  provider: ProviderId;
  profileId: string | null;
  model: string;
  worktree: string;
  status: "pending" | "started";
  messages: ForkTransferMessage[];
  annotations: ForkTransferAnnotation[];
  files: [];
  summaries: [];
  prompt: string;
  byteCount: number;
  createdAt: string;
  startedAt: string | null;
}

export interface Turn {
  schemaVersion: 2;
  id: string;
  threadId: string;
  status:
    | "active"
    | "idle"
    | "waiting_for_user"
    | "waiting_for_approval"
    | "completed"
    | "failed"
    | "interrupted"
    | "running"
    | "cancelled";
  createdAt: string;
  completedAt: string | null;
  mode?: InteractionMode;
  providerRunId?: string;
}

export interface Message {
  schemaVersion: 2;
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Event-log position used to restore cross-record provider ordering. */
  eventSequence?: number;
}

export interface Activity {
  schemaVersion: 2;
  id: string;
  turnId: string;
  kind: "tool_started" | "tool_finished" | "provider_failed";
  toolCallId: string | null;
  name: string | null;
  failed: boolean | null;
  message: string | null;
  createdAt: string;
  /** Event-log position used to restore cross-record provider ordering. */
  eventSequence?: number;
}

export interface PlanArtifact {
  schemaVersion: 2;
  id: string;
  artifactId: string;
  threadId: string;
  turnId: string;
  provider: ProviderId;
  title?: string;
  body?: string;
  steps?: ProviderPlanStep[];
  createdAt: string;
  updatedAt: string;
  /** Position of the first update, keeping the card anchored in the timeline. */
  eventSequence?: number;
}

export interface ContextReceipt {
  schemaVersion: 2;
  id: string;
  threadId: string;
  turnId: string;
  pins: ContextPin[];
  entries: ContextReceiptEntry[];
  totalBytes: number;
  estimatedTokens: number;
  digest: string;
  createdAt: string;
}

export interface ProviderSessionReference {
  schemaVersion: 2;
  threadId: string;
  provider: ProviderId;
  sessionId: string;
  model: string | null;
  profileId?: string;
  continuationKey?: string;
  updatedAt: string;
}

export type CheckpointState = "baseline" | "completed" | "failed" | "superseded" | "unavailable";

export interface CheckpointFile {
  path: string;
  state: "added" | "modified" | "deleted" | "renamed" | "binary";
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface TurnCheckpoint {
  schemaVersion: 2;
  id: string;
  turnId: string;
  threadId: string;
  worktree: string;
  gitDirectory: string | null;
  baselineHead: string | null;
  baselineIdentity: string | null;
  baselineIndexIdentity: string | null;
  completedIdentity: string | null;
  completedIndexIdentity: string | null;
  completedHead: string | null;
  state: CheckpointState;
  message: string | null;
  /** Metadata-only summary of the completed turn's tree diff. */
  files?: CheckpointFile[];
  createdAt: string;
  updatedAt: string;
}

export type AnnotationResolution = "unresolved" | "resolved";
export type AnnotationScope = "file" | "line";

export interface DiffAnnotation {
  schemaVersion: 2;
  id: string;
  threadId: string;
  checkpointId: string | null;
  diffIdentity: string;
  path: string;
  previousPath: string | null;
  targetState: "added" | "modified" | "deleted" | "renamed" | "binary" | "oversized";
  scope: AnnotationScope;
  side: "addition" | "deletion" | "context" | null;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  capturedContext: string;
  resolution: AnnotationResolution;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-file review progress for a thread. Anchored to content via diffIdentity
 * (same scheme as annotations) so a rebase invalidates the review row rather
 * than leaving a false positive on a line number.
 */
export interface FileReview {
  schemaVersion: 2;
  id: string;
  threadId: string;
  path: string;
  previousPath: string | null;
  diffIdentity: string;
  reviewed: boolean;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Derived sidebar status — computed server-side so the client only does elapsed time. */
export type ThreadStatus =
  "pending_approval" | "awaiting_input" | "running" | "failed" | "completed" | "idle";

export interface ThreadStatusProjection {
  threadId: string;
  status: ThreadStatus;
  since: string;
}

export interface DelegatedConversationOutcomeProjection {
  childThreadId: string;
  completedAt: string;
  summary: string;
}

export interface GovernanceCorrelationReceipt {
  schemaVersion: 2;
  id: string;
  provider: "shikigami";
  governance: "sekai-chisei";
  threadId: string;
  turnId: string;
  runId: string;
  operationId: string;
  createdAt: string;
}

export interface StateProjection {
  schemaVersion: 2;
  sequence: number;
  projects: Project[];
  threads: Thread[];
  turns: Turn[];
  messages: Message[];
  activities: Activity[];
  plans: PlanArtifact[];
  contextReceipts: ContextReceipt[];
  governanceCorrelations: GovernanceCorrelationReceipt[];
  providerSessions: ProviderSessionReference[];
  checkpoints: TurnCheckpoint[];
  annotations: DiffAnnotation[];
  fileReviews: FileReview[];
  conversationDeletions: ConversationDeletion[];
  forks: ConversationFork[];
  delegatedRelationships: DelegatedConversationRelationship[];
  inputRequests: ChildInputRequest[];
  inputReceipts: ChildInputReceipt[];
  automationFires: AutomationFire[];
  autonomyRuns: AutonomyRun[];
  autonomyTasks: AutonomyTask[];
  autonomyFlows: AutonomyFlow[];
  heartbeatMonitors: HeartbeatMonitor[];
  standingOrders: StandingOrder[];
  autonomyHooks: AutonomyHook[];
}

type StateEvent =
  | { type: "project_saved"; project: Project }
  | { type: "thread_saved"; thread: Thread }
  | { type: "turn_saved"; turn: Turn }
  | { type: "message_saved"; message: Message }
  | { type: "activity_saved"; activity: Activity }
  | { type: "plan_saved"; plan: PlanArtifact }
  | { type: "context_receipt_saved"; contextReceipt: ContextReceipt }
  | { type: "governance_correlation_saved"; governanceCorrelation: GovernanceCorrelationReceipt }
  | { type: "provider_session_saved"; providerSession: ProviderSessionReference }
  | { type: "checkpoint_saved"; checkpoint: TurnCheckpoint }
  | { type: "annotation_saved"; annotation: DiffAnnotation }
  | { type: "file_review_saved"; fileReview: FileReview }
  | { type: "conversation_deletion_saved"; conversationDeletion: ConversationDeletion }
  | { type: "fork_created"; thread: Thread; fork: ConversationFork }
  | { type: "fork_saved"; fork: ConversationFork }
  | {
      type: "delegated_relationship_saved";
      delegatedRelationship: DelegatedConversationRelationship;
    }
  | { type: "input_request_saved"; inputRequest: ChildInputRequest }
  | { type: "input_receipt_saved"; inputReceipt: ChildInputReceipt }
  | { type: "automation_fire_saved"; automationFire: AutomationFire }
  | { type: "autonomy_run_saved"; autonomyRun: AutonomyRun }
  | { type: "autonomy_task_saved"; autonomyTask: AutonomyTask }
  | { type: "autonomy_flow_saved"; autonomyFlow: AutonomyFlow }
  | { type: "heartbeat_monitor_saved"; heartbeatMonitor: HeartbeatMonitor }
  | { type: "standing_order_saved"; standingOrder: StandingOrder }
  | { type: "autonomy_hook_saved"; autonomyHook: AutonomyHook };

interface EventEnvelope {
  schemaVersion: 2;
  sequence: number;
  id: string;
  recordedAt: string;
  event: StateEvent;
}

export class LocalStateError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

function emptyProjection(): StateProjection {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    sequence: 0,
    projects: [],
    threads: [],
    turns: [],
    messages: [],
    activities: [],
    plans: [],
    contextReceipts: [],
    governanceCorrelations: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
    delegatedRelationships: [],
    inputRequests: [],
    inputReceipts: [],
    automationFires: [],
    autonomyRuns: [],
    autonomyTasks: [],
    autonomyFlows: [],
    heartbeatMonitors: [],
    standingOrders: [],
    autonomyHooks: [],
  };
}

type AutomationFireTerminalStatus = Exclude<AutomationFireStatus, "started" | "skipped_busy">;

function automationFireOutcome(
  projection: StateProjection,
  fire: AutomationFire,
): { status: AutomationFireTerminalStatus; error: string | null } {
  const turn = fire.turnId ? projection.turns.find((item) => item.id === fire.turnId) : undefined;
  if (turn?.status === "completed") return { status: "completed", error: null };
  if (turn?.status === "failed") return { status: "failed", error: "The provider turn failed." };
  return {
    status: "unknown",
    error: "The provider outcome could not be proven after the host stopped or disconnected.",
  };
}

const WAKE_THREAD_STATUSES = new Set<ThreadStatus>([
  "pending_approval",
  "awaiting_input",
  "failed",
]);

export function projectThreadStatus(
  projection: StateProjection,
  threadId: string,
): ThreadStatusProjection {
  const thread = projection.threads.find((item) => item.id === threadId);
  const turns = projection.turns
    .filter((turn) => turn.threadId === threadId)
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latest = turns.at(-1);
  const approval = [...turns].reverse().find((turn) => turn.status === "waiting_for_approval");
  if (approval) {
    return {
      threadId,
      status: "pending_approval",
      since:
        thread?.wokeAt && thread.wokeAt >= approval.createdAt ? thread.wokeAt : approval.createdAt,
    };
  }
  const awaiting = [...turns].reverse().find((turn) => turn.status === "waiting_for_user");
  if (awaiting) {
    return {
      threadId,
      status: "awaiting_input",
      since:
        thread?.wokeAt && thread.wokeAt >= awaiting.createdAt ? thread.wokeAt : awaiting.createdAt,
    };
  }
  const running = [...turns]
    .reverse()
    .find((turn) => turn.status === "active" || turn.status === "running");
  if (running) {
    return { threadId, status: "running", since: running.createdAt };
  }
  if (latest?.status === "failed") {
    return {
      threadId,
      status: "failed",
      since:
        latest.completedAt ??
        (thread?.wokeAt && thread.wokeAt >= latest.createdAt ? thread.wokeAt : latest.createdAt),
    };
  }
  if (latest?.status === "completed") {
    return {
      threadId,
      status: "completed",
      since: latest.completedAt ?? latest.createdAt,
    };
  }
  return {
    threadId,
    status: "idle",
    since:
      latest?.completedAt ??
      latest?.createdAt ??
      thread?.updatedAt ??
      thread?.createdAt ??
      new Date(0).toISOString(),
  };
}

export function projectThreadStatuses(projection: StateProjection): ThreadStatusProjection[] {
  return projection.threads.map((thread) => projectThreadStatus(projection, thread.id));
}

export function projectDelegatedConversationOutcomes(
  projection: StateProjection,
): DelegatedConversationOutcomeProjection[] {
  const childIds = new Set(
    projection.delegatedRelationships.map((relationship) => relationship.childThreadId),
  );
  const latestByChild = new Map<string, Turn>();
  for (const turn of projection.turns) {
    if (!childIds.has(turn.threadId) || turn.status !== "completed") continue;
    const previous = latestByChild.get(turn.threadId);
    if (
      !previous ||
      turn.createdAt > previous.createdAt ||
      (turn.createdAt === previous.createdAt && turn.id > previous.id)
    ) {
      latestByChild.set(turn.threadId, turn);
    }
  }
  const childByTurn = new Map(
    [...latestByChild].map(([childThreadId, turn]) => [turn.id, childThreadId]),
  );
  const lastToolStartByTurn = new Map<string, number>();
  for (const activity of projection.activities) {
    if (
      !childByTurn.has(activity.turnId) ||
      activity.kind !== "tool_started" ||
      activity.eventSequence === undefined
    )
      continue;
    lastToolStartByTurn.set(
      activity.turnId,
      Math.max(lastToolStartByTurn.get(activity.turnId) ?? 0, activity.eventSequence),
    );
  }
  type BoundedSummary = {
    text: string;
    truncated: boolean;
    pendingWhitespace: string;
  };
  const appendBoundedTail = (current: BoundedSummary | undefined, next: string): BoundedSummary => {
    if (!next.trim()) {
      const whitespace = `${current?.pendingWhitespace ?? ""}${next}`;
      return {
        text: current?.text ?? "",
        truncated: current?.truncated ?? false,
        pendingWhitespace: whitespace.includes("\n") ? "\n\n" : " ",
      };
    }
    const substantive = next.trimEnd();
    const trailingWhitespace = next.slice(substantive.length);
    const joined = joinAssistantTextChunks([
      current?.text ?? "",
      current?.pendingWhitespace ?? "",
      substantive,
    ]);
    const characters = Array.from(joined);
    return {
      text: characters.slice(-500).join(""),
      truncated: Boolean(current?.truncated) || characters.length > 500,
      pendingWhitespace: trailingWhitespace.includes("\n") ? "\n\n" : trailingWhitespace,
    };
  };
  const allAssistantByChild = new Map<string, BoundedSummary>();
  const finalAssistantByChild = new Map<string, BoundedSummary>();
  for (const message of projection.messages) {
    const childThreadId = childByTurn.get(message.turnId);
    if (!childThreadId || message.role !== "assistant") continue;
    allAssistantByChild.set(
      childThreadId,
      appendBoundedTail(allAssistantByChild.get(childThreadId), message.text),
    );
    const lastToolStart = lastToolStartByTurn.get(message.turnId);
    if (
      lastToolStart === undefined ||
      message.eventSequence === undefined ||
      message.eventSequence > lastToolStart
    ) {
      finalAssistantByChild.set(
        childThreadId,
        appendBoundedTail(finalAssistantByChild.get(childThreadId), message.text),
      );
    }
  }
  return [...childIds].flatMap((childThreadId) => {
    const latest = latestByChild.get(childThreadId);
    if (!latest) return [];
    const finalAssistant = finalAssistantByChild.get(childThreadId);
    const projected = finalAssistant?.text.trim()
      ? finalAssistant
      : allAssistantByChild.get(childThreadId);
    const summary = (projected?.text ?? "").trim();
    return [
      {
        childThreadId,
        completedAt: latest.completedAt ?? latest.createdAt,
        summary: summary
          ? `${projected?.truncated ? "…" : ""}${summary}`
          : "No written result was recorded.",
      },
    ];
  });
}

export function isWakeThreadStatus(status: ThreadStatus): boolean {
  return WAKE_THREAD_STATUSES.has(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedSchemaVersion(value: unknown): value is number {
  return typeof value === "number" && SUPPORTED_LOCAL_STATE_SCHEMA_VERSIONS.has(value);
}

/** Default missing lifecycle timestamps the same way preferences default managedWorktreeLimit. */
function migrateNullableTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new LocalStateError("Local history is corrupt.");
}

function migrateThreadRecord(payload: Record<string, unknown>): Thread {
  const workspaceMode = payload.workspaceMode === undefined ? "shared" : payload.workspaceMode;
  if (
    workspaceMode !== "shared" &&
    workspaceMode !== "aldunis-managed" &&
    workspaceMode !== "provider-native"
  ) {
    throw new LocalStateError("Local history is corrupt.");
  }
  return {
    ...(payload as unknown as Omit<
      Thread,
      "schemaVersion" | "settledAt" | "snoozedUntil" | "snoozedAt" | "wokeAt" | "lastVisitedAt"
    >),
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    workspaceMode,
    settledAt: migrateNullableTimestamp(payload.settledAt),
    snoozedUntil: migrateNullableTimestamp(payload.snoozedUntil),
    snoozedAt: migrateNullableTimestamp(payload.snoozedAt),
    wokeAt: migrateNullableTimestamp(payload.wokeAt),
    lastVisitedAt: migrateNullableTimestamp(payload.lastVisitedAt),
  };
}

function migrateEntityRecord<T extends { schemaVersion: number }>(
  payload: Record<string, unknown>,
): T {
  return {
    ...(payload as unknown as T),
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
  };
}

function replaceById<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index === -1) items.push(value);
  else items[index] = value;
}

/**
 * ACP streams (Grok, Kiro, …) persist many tiny assistant_text rows. For fork
 * transfer and the exact-messages review list, join consecutive assistant
 * chunks so the operator sees readable replies rather than 100+ token rows.
 */
export function coalesceForkTransferMessages(
  messages: ForkTransferMessage[],
): ForkTransferMessage[] {
  if (messages.length === 0) return [];
  const sorted = [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const coalesced: ForkTransferMessage[] = [];
  for (const message of sorted) {
    const previous = coalesced[coalesced.length - 1];
    if (previous && previous.role === "assistant" && message.role === "assistant") {
      previous.text = `${previous.text}${message.text}`;
      continue;
    }
    coalesced.push({ ...message });
  }
  return coalesced;
}

function renderForkPrompt(
  source: Thread,
  messages: ForkTransferMessage[],
  annotations: ForkTransferAnnotation[],
): string {
  const sections = [
    "Continue this investigation in a new provider-native conversation.",
    `Source conversation: ${source.title}`,
    "The following context was explicitly reviewed for cross-provider transfer.",
  ];
  if (messages.length) {
    sections.push(
      "Conversation messages:",
      ...messages.map((message) => `[${message.role}] ${message.text}`),
    );
  }
  if (annotations.length) {
    sections.push(
      "User-authored diff annotations:",
      ...annotations.map(
        (annotation) =>
          `${annotation.path}: ${annotation.text}${
            annotation.capturedContext ? `\nContext: ${annotation.capturedContext}` : ""
          }`,
      ),
    );
  }
  sections.push(
    "Excluded by policy: provider credentials, environment values, native session identifiers, hidden reasoning, raw tool inputs and outputs, and approval state.",
  );
  return sections.join("\n\n");
}

function buildForkPreview(source: Thread, projection: StateProjection) {
  const turnIds = new Set(
    projection.turns.filter((turn) => turn.threadId === source.id).map((turn) => turn.id),
  );
  const messages = coalesceForkTransferMessages(
    projection.messages
      .filter((message) => turnIds.has(message.turnId))
      .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
  );
  const annotations = projection.annotations
    .filter((annotation) => annotation.threadId === source.id)
    .map(({ id, path, text, capturedContext }) => ({ id, path, text, capturedContext }));
  const prompt = renderForkPrompt(source, messages, annotations);
  const byteCount = Buffer.byteLength(prompt, "utf8");
  const digest = createHash("sha256").update(prompt, "utf8").digest("hex");
  return {
    sourceThreadId: source.id,
    sourceProvider: source.provider,
    workspaceMode: source.workspaceMode ?? ("shared" as const),
    worktree: source.worktree,
    messages,
    annotations,
    files: [] as [],
    summaries: [] as [],
    prompt,
    byteCount,
    digest,
    contextPackage: {
      pins: [] as [],
      entries: [] as [],
      totalBytes: byteCount,
      estimatedTokens: Math.ceil(byteCount / 4),
      digest,
    },
    excluded: [
      "Provider credentials and environment values",
      "Native provider session identifiers",
      "Hidden reasoning",
      "Raw tool inputs and outputs",
      "Tool approvals and runtime activity",
      "Provider plan artifacts",
    ],
  };
}

function applyEvent(projection: StateProjection, envelope: EventEnvelope): void {
  if (envelope.sequence !== projection.sequence + 1) {
    throw new LocalStateError(
      `Local history is not ordered at event ${envelope.sequence}; expected ${projection.sequence + 1}.`,
    );
  }
  const event = envelope.event;
  if (event.type === "project_saved") replaceById(projection.projects, event.project);
  else if (event.type === "thread_saved") replaceById(projection.threads, event.thread);
  else if (event.type === "turn_saved") replaceById(projection.turns, event.turn);
  else if (event.type === "message_saved") {
    replaceById(projection.messages, { ...event.message, eventSequence: envelope.sequence });
  } else if (event.type === "activity_saved") {
    replaceById(projection.activities, { ...event.activity, eventSequence: envelope.sequence });
  } else if (event.type === "plan_saved") {
    const existing = projection.plans.find((plan) => plan.id === event.plan.id);
    replaceById(projection.plans, {
      ...event.plan,
      eventSequence: existing?.eventSequence ?? envelope.sequence,
    });
  } else if (event.type === "context_receipt_saved") {
    replaceById(projection.contextReceipts, event.contextReceipt);
  } else if (event.type === "governance_correlation_saved") {
    replaceById(projection.governanceCorrelations, event.governanceCorrelation);
  } else if (event.type === "provider_session_saved") {
    const index = projection.providerSessions.findIndex(
      (item) =>
        item.threadId === event.providerSession.threadId &&
        item.provider === event.providerSession.provider,
    );
    if (index === -1) projection.providerSessions.push(event.providerSession);
    else projection.providerSessions[index] = event.providerSession;
  } else if (event.type === "checkpoint_saved") {
    replaceById(projection.checkpoints, event.checkpoint);
  } else if (event.type === "annotation_saved") {
    replaceById(projection.annotations, event.annotation);
  } else if (event.type === "file_review_saved") {
    replaceById(projection.fileReviews, event.fileReview);
  } else if (event.type === "conversation_deletion_saved") {
    const index = projection.conversationDeletions.findIndex(
      (item) => item.threadId === event.conversationDeletion.threadId,
    );
    if (index === -1) projection.conversationDeletions.push(event.conversationDeletion);
    else projection.conversationDeletions[index] = event.conversationDeletion;
  } else if (event.type === "fork_created") {
    replaceById(projection.threads, event.thread);
    replaceById(projection.forks, event.fork);
  } else if (event.type === "fork_saved") {
    replaceById(projection.forks, event.fork);
  } else if (event.type === "delegated_relationship_saved") {
    replaceById(projection.delegatedRelationships, event.delegatedRelationship);
  } else if (event.type === "input_request_saved") {
    replaceById(projection.inputRequests, event.inputRequest);
  } else if (event.type === "input_receipt_saved") {
    replaceById(projection.inputReceipts, event.inputReceipt);
  } else if (event.type === "automation_fire_saved") {
    replaceById(projection.automationFires, event.automationFire);
  } else if (event.type === "autonomy_run_saved") {
    replaceById(projection.autonomyRuns, event.autonomyRun);
  } else if (event.type === "autonomy_task_saved") {
    replaceById(projection.autonomyTasks, event.autonomyTask);
  } else if (event.type === "autonomy_flow_saved") {
    replaceById(projection.autonomyFlows, event.autonomyFlow);
  } else if (event.type === "heartbeat_monitor_saved") {
    replaceById(projection.heartbeatMonitors, event.heartbeatMonitor);
  } else if (event.type === "standing_order_saved") {
    replaceById(projection.standingOrders, event.standingOrder);
  } else if (event.type === "autonomy_hook_saved") {
    replaceById(projection.autonomyHooks, event.autonomyHook);
  } else {
    throw new LocalStateError("Local history contains an unsupported event type.");
  }
  projection.sequence = envelope.sequence;
}

function parseEnvelope(line: string, lineNumber: number): EventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LocalStateError(`Local history is corrupt at line ${lineNumber}.`);
  }
  if (!isRecord(value) || !isSupportedSchemaVersion(value.schemaVersion)) {
    throw new LocalStateError(`Local history uses an incompatible schema at line ${lineNumber}.`);
  }
  if (
    typeof value.sequence !== "number" ||
    typeof value.id !== "string" ||
    typeof value.recordedAt !== "string" ||
    !isRecord(value.event) ||
    typeof value.event.type !== "string"
  ) {
    throw new LocalStateError(`Local history is corrupt at line ${lineNumber}.`);
  }
  const event = value.event;
  const payloadKey: Record<string, string> = {
    project_saved: "project",
    thread_saved: "thread",
    turn_saved: "turn",
    message_saved: "message",
    activity_saved: "activity",
    plan_saved: "plan",
    context_receipt_saved: "contextReceipt",
    governance_correlation_saved: "governanceCorrelation",
    provider_session_saved: "providerSession",
    checkpoint_saved: "checkpoint",
    annotation_saved: "annotation",
    file_review_saved: "fileReview",
    conversation_deletion_saved: "conversationDeletion",
    fork_created: "fork",
    fork_saved: "fork",
    delegated_relationship_saved: "delegatedRelationship",
    input_request_saved: "inputRequest",
    input_receipt_saved: "inputReceipt",
    automation_fire_saved: "automationFire",
    autonomy_run_saved: "autonomyRun",
    autonomy_task_saved: "autonomyTask",
    autonomy_flow_saved: "autonomyFlow",
    heartbeat_monitor_saved: "heartbeatMonitor",
    standing_order_saved: "standingOrder",
    autonomy_hook_saved: "autonomyHook",
  };
  const key = payloadKey[event.type as string];
  const payload = key ? event[key] : undefined;
  const forkThread = event.type === "fork_created" ? event.thread : undefined;
  if (
    !key ||
    !isRecord(payload) ||
    !isSupportedSchemaVersion(payload.schemaVersion) ||
    (event.type === "fork_created" &&
      (!isRecord(forkThread) ||
        !isSupportedSchemaVersion(forkThread.schemaVersion) ||
        typeof forkThread.id !== "string")) ||
    (key === "providerSession"
      ? typeof payload.threadId !== "string" || typeof payload.sessionId !== "string"
      : key === "conversationDeletion"
        ? typeof payload.threadId !== "string"
        : typeof payload.id !== "string")
  ) {
    throw new LocalStateError(`Local history is corrupt at line ${lineNumber}.`);
  }

  // Migrate version-1 records into the current schema before applying.
  try {
    if (event.type === "thread_saved") {
      event.thread = migrateThreadRecord(payload);
    } else if (event.type === "fork_created") {
      event.thread = migrateThreadRecord(forkThread as Record<string, unknown>);
      event.fork = migrateEntityRecord(payload);
    } else if (event.type === "conversation_deletion_saved") {
      const migrated = migrateEntityRecord<ConversationDeletion>(payload);
      const records = isRecord(payload.affectedRecords) ? payload.affectedRecords : {};
      event.conversationDeletion = {
        ...migrated,
        affectedRecords: {
          thread: Number(records.thread ?? 0),
          turns: Number(records.turns ?? 0),
          messages: Number(records.messages ?? 0),
          activities: Number(records.activities ?? 0),
          plans: Number(records.plans ?? 0),
          contextReceipts: Number(records.contextReceipts ?? 0),
          governanceCorrelations: Number(records.governanceCorrelations ?? 0),
          providerSessions: Number(records.providerSessions ?? 0),
          checkpoints: Number(records.checkpoints ?? 0),
          annotations: Number(records.annotations ?? 0),
          fileReviews: Number(records.fileReviews ?? 0),
          forks: Number(records.forks ?? 0),
          delegatedRelationships: Number(records.delegatedRelationships ?? 0),
          inputRequests: Number(records.inputRequests ?? 0),
          inputReceipts: Number(records.inputReceipts ?? 0),
        },
      };
    } else {
      event[key] = migrateEntityRecord(payload);
    }
    if (event.type === "autonomy_run_saved") {
      event.autonomyRun = parseAutonomyRun(event.autonomyRun);
    } else if (event.type === "autonomy_task_saved") {
      event.autonomyTask = parseAutonomyTask(event.autonomyTask);
    } else if (event.type === "autonomy_flow_saved") {
      event.autonomyFlow = parseAutonomyFlow(event.autonomyFlow);
    } else if (event.type === "heartbeat_monitor_saved") {
      event.heartbeatMonitor = parseHeartbeatMonitor(event.heartbeatMonitor);
    } else if (event.type === "standing_order_saved") {
      event.standingOrder = parseStandingOrder(event.standingOrder);
    } else if (event.type === "autonomy_hook_saved") {
      event.autonomyHook = parseAutonomyHook(event.autonomyHook);
    }
  } catch (error) {
    if (error instanceof LocalStateError) {
      throw new LocalStateError(`Local history is corrupt at line ${lineNumber}.`);
    }
    throw new LocalStateError(`Local history is corrupt at line ${lineNumber}.`);
  }

  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    sequence: value.sequence as number,
    id: value.id as string,
    recordedAt: value.recordedAt as string,
    event: event as unknown as StateEvent,
  };
}

export function defaultStateDirectory(): string {
  const configured = process.env.ALDUNIS_CODE_STATE_DIR;
  if (configured) return configured;
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "aldunis-code");
}

export class LocalStateStore {
  readonly #eventPath: string;
  #projection = emptyProjection();
  #writeQueue: Promise<void> = Promise.resolve();
  #loaded = false;

  constructor(readonly directory = defaultStateDirectory()) {
    this.#eventPath = join(directory, "events.v1.jsonl");
  }

  async #readProjection(): Promise<{
    envelopes: EventEnvelope[];
    projection: StateProjection;
    repaired: boolean;
  }> {
    let contents = "";
    try {
      contents = await readFile(this.#eventPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LocalStateError("Local history could not be read.");
      }
    }
    const parsedEnvelopes: EventEnvelope[] = [];
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      parsedEnvelopes.push(parseEnvelope(lines[index], index + 1));
    }
    const sequences = new Set(parsedEnvelopes.map((envelope) => envelope.sequence));
    const maximumSequence = parsedEnvelopes.reduce(
      (maximum, envelope) => Math.max(maximum, envelope.sequence),
      0,
    );
    const firstMismatch = parsedEnvelopes.findIndex(
      (envelope, index) => envelope.sequence !== index + 1,
    );
    const repaired = firstMismatch !== -1;
    if (repaired) {
      const isCompleteFork =
        maximumSequence > 0 &&
        parsedEnvelopes.length > maximumSequence &&
        sequences.size === maximumSequence &&
        Array.from({ length: maximumSequence }, (_, index) => sequences.has(index + 1)).every(
          Boolean,
        );
      if (!isCompleteFork) {
        const envelope = parsedEnvelopes[firstMismatch];
        throw new LocalStateError(
          `Local history is not ordered at event ${envelope.sequence}; expected ${firstMismatch + 1}.`,
        );
      }
    }
    const projection = emptyProjection();
    const envelopes = parsedEnvelopes.map((parsed, index) =>
      repaired ? { ...parsed, sequence: index + 1 } : parsed,
    );
    for (const envelope of envelopes) {
      applyEvent(projection, envelope);
    }
    return { envelopes, projection, repaired };
  }

  async #replaceHistory(envelopes: EventEnvelope[]): Promise<void> {
    const temporary = join(this.directory, `.events-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      const lines = envelopes.map((envelope) => JSON.stringify(envelope));
      await handle.writeFile(lines.length ? `${lines.join("\n")}\n` : "", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#eventPath);
      const directoryHandle = await open(dirname(this.#eventPath), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async acquireWriterLease(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      return await lock(join(this.directory, "host-writer"), {
        realpath: false,
        stale: 30_000,
        update: 10_000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new LocalStateError(
          "Another Aldunis Code host is already using this local state directory.",
          503,
        );
      }
      throw error;
    }
  }

  async load(): Promise<StateProjection> {
    if (this.#loaded) return structuredClone(this.#projection);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const history = await this.#readProjection();
    if (history.repaired) await this.#replaceHistory(history.envelopes);
    this.#projection = history.projection;
    this.#loaded = true;
    return structuredClone(this.#projection);
  }

  async #append(event: StateEvent): Promise<void> {
    await this.#appendComputed(() => ({ event, value: undefined }));
  }

  async #appendComputed<T>(
    compute: (projection: StateProjection) => { event: StateEvent | StateEvent[] | null; value: T },
  ): Promise<T> {
    await this.load();
    let result!: T;
    const operation = this.#writeQueue.then(async () => {
      const computed = compute(this.#projection);
      result = computed.value;
      if (!computed.event) return;
      const events = Array.isArray(computed.event) ? computed.event : [computed.event];
      for (const event of events) {
        const envelope: EventEnvelope = {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          sequence: this.#projection.sequence + 1,
          id: randomUUID(),
          recordedAt: new Date().toISOString(),
          event,
        };
        const handle = await open(this.#eventPath, "a", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        applyEvent(this.#projection, envelope);
      }
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async saveProject(
    input: Omit<Project, "schemaVersion" | "openedAt"> & { openedAt?: string },
  ): Promise<Project> {
    return this.#appendComputed((projection) => {
      const existing = projection.projects.find((project) => project.id === input.id);
      // Preserve first-open time on reselect so project chips do not reshuffle.
      const openedAt = input.openedAt ?? existing?.openedAt ?? new Date().toISOString();
      const project: Project = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: input.id,
        name: input.name,
        root: input.root,
        openedAt,
        chiseiNamespace: input.chiseiNamespace ?? existing?.chiseiNamespace ?? null,
      };
      const unchanged =
        existing &&
        existing.name === project.name &&
        existing.root === project.root &&
        existing.openedAt === project.openedAt &&
        (existing.chiseiNamespace ?? null) === project.chiseiNamespace;
      return {
        event: unchanged ? null : { type: "project_saved", project },
        value: unchanged ? existing : project,
      };
    });
  }

  async bindProjectChiseiNamespace(projectId: string, namespace: string | null): Promise<Project> {
    const normalized = namespace?.trim() || null;
    if (normalized && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(normalized)) {
      throw new LocalStateError("The Chisei namespace is invalid.", 400);
    }
    return this.#appendComputed((projection) => {
      const project = projection.projects.find((item) => item.id === projectId);
      if (!project) throw new LocalStateError("The selected project is unavailable.", 404);
      const next = { ...project, chiseiNamespace: normalized };
      const unchanged = (project.chiseiNamespace ?? null) === normalized;
      return {
        event: unchanged ? null : { type: "project_saved", project: next },
        value: unchanged ? project : next,
      };
    });
  }

  async startTurn(input: {
    projectId: string;
    worktree: string;
    prompt: string;
    mode: InteractionMode;
    provider: ProviderId;
    model?: string | null;
    reasoningEffort?: ReasoningEffort;
    threadId?: string;
    contextPins?: ContextPin[];
    workspaceMode?: WorkspaceMode;
  }): Promise<{ thread: Thread; turn: Turn }> {
    return this.#appendComputed((projection) => {
      if (!projection.projects.some((project) => project.id === input.projectId)) {
        throw new LocalStateError("The selected project is not in local history.", 404);
      }
      if (
        !input.threadId &&
        projection.threads.filter((thread) => thread.projectId === input.projectId).length >=
          MAX_THREADS_PER_PROJECT
      ) {
        throw new LocalStateError(
          `This project has reached the ${MAX_THREADS_PER_PROJECT}-conversation local retention limit. Delete or retain older conversations before starting another.`,
          429,
        );
      }
      const now = new Date().toISOString();
      const existing = input.threadId
        ? projection.threads.find((thread) => thread.id === input.threadId)
        : undefined;
      if (input.threadId && (!existing || existing.projectId !== input.projectId)) {
        throw new LocalStateError("The selected conversation is not available.", 404);
      }
      if (existing) {
        const providerSession = projection.providerSessions.find(
          (session) => session.threadId === existing.id,
        );
        const existingProvider = existing.provider ?? providerSession?.provider ?? "claude-code";
        if (existingProvider && existingProvider !== input.provider) {
          throw new LocalStateError(
            `This conversation belongs to ${existingProvider} and cannot switch providers.`,
            409,
          );
        }
        if (existing.worktree !== input.worktree) {
          throw new LocalStateError(
            "This conversation is bound to a different canonical worktree and cannot be silently moved.",
            409,
          );
        }
        if (input.workspaceMode && (existing.workspaceMode ?? "shared") !== input.workspaceMode) {
          throw new LocalStateError(
            "This conversation uses a different workspace mode and cannot be silently changed.",
            409,
          );
        }
      }
      const workspaceMode = existing?.workspaceMode ?? input.workspaceMode ?? "shared";
      if (
        !input.threadId &&
        workspaceMode === "aldunis-managed" &&
        projection.threads.some((thread) => thread.worktree === input.worktree)
      ) {
        throw new LocalStateError(
          "Each Aldunis-managed conversation needs its own worktree. Create a new one before starting this chat.",
          409,
        );
      }
      const thread: Thread = existing
        ? {
            ...existing,
            workspaceMode,
            provider: existing.provider ?? input.provider,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            ...(input.contextPins ? { contextPins: input.contextPins } : {}),
            updatedAt: now,
          }
        : {
            schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
            id: randomUUID(),
            projectId: input.projectId,
            title: input.prompt.slice(0, 80),
            worktree: input.worktree,
            workspaceMode,
            provider: input.provider,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            contextPins: input.contextPins ?? [],
            createdAt: now,
            updatedAt: now,
            pinnedAt: null,
            archivedAt: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            wokeAt: null,
            lastVisitedAt: null,
          };
      const turn: Turn = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        threadId: thread.id,
        status: "active",
        createdAt: now,
        completedAt: null,
        mode: input.mode,
      };
      const message: Message = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        turnId: turn.id,
        role: "user",
        text: input.prompt,
        createdAt: now,
      };
      return {
        event: [
          { type: "thread_saved", thread },
          { type: "turn_saved", turn },
          { type: "message_saved", message },
        ],
        value: { thread, turn },
      };
    });
  }

  async saveContextReceipt(
    receipt: Omit<ContextReceipt, "schemaVersion" | "id" | "createdAt">,
  ): Promise<ContextReceipt> {
    const projection = await this.load();
    const turn = projection.turns.find(
      (item) => item.id === receipt.turnId && item.threadId === receipt.threadId,
    );
    if (!turn) throw new LocalStateError("The context receipt turn is unavailable.", 404);
    const saved: ContextReceipt = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      id: createHash("sha256")
        .update(`${receipt.threadId}\n${receipt.turnId}\n${receipt.digest}`, "utf8")
        .digest("hex"),
      ...receipt,
      createdAt: new Date().toISOString(),
    };
    await this.#append({ type: "context_receipt_saved", contextReceipt: saved });
    return saved;
  }

  async createFork(input: {
    sourceThreadId: string;
    provider: ProviderId;
    profileId: string | null;
    model: string;
    worktree: string;
    destinationWorktree?: string;
    workspaceMode?: WorkspaceMode;
    expectedDigest: string;
  }): Promise<{ thread: Thread; fork: ConversationFork }> {
    const projection = await this.load();
    const source = projection.threads.find((thread) => thread.id === input.sourceThreadId);
    if (!source) throw new LocalStateError("The source conversation is unavailable.", 404);
    if (source.provider === input.provider) {
      throw new LocalStateError("Choose a different provider for this fork.", 409);
    }
    if (source.worktree !== input.worktree) {
      throw new LocalStateError("The source worktree changed after the fork preview.", 409);
    }
    const destinationWorktree = input.destinationWorktree ?? source.worktree;
    const destinationWorkspaceMode = input.workspaceMode ?? source.workspaceMode ?? "shared";
    if (
      source.workspaceMode === "aldunis-managed" &&
      destinationWorkspaceMode !== "aldunis-managed"
    ) {
      throw new LocalStateError(
        "A fork from an Aldunis-managed conversation requires a distinct Aldunis-managed worktree.",
        409,
      );
    }
    if (destinationWorkspaceMode === "aldunis-managed" && destinationWorktree === source.worktree) {
      throw new LocalStateError(
        "Aldunis-managed forks cannot reuse the source conversation's worktree.",
        409,
      );
    }
    if (
      projection.threads.filter((thread) => thread.projectId === source.projectId).length >=
      MAX_THREADS_PER_PROJECT
    ) {
      throw new LocalStateError(
        `This project has reached the ${MAX_THREADS_PER_PROJECT}-conversation local retention limit.`,
        429,
      );
    }
    const preview = await this.previewFork(source.id);
    const { messages, annotations, prompt, byteCount } = preview;
    if (preview.digest !== input.expectedDigest) {
      throw new LocalStateError("The source context changed after the fork preview.", 409);
    }
    if (byteCount > 64 * 1024) {
      throw new LocalStateError("The reviewed context exceeds the 64 KiB fork limit.", 413);
    }
    const now = new Date().toISOString();
    const forkId = randomUUID();
    const thread: Thread = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      id: randomUUID(),
      projectId: source.projectId,
      title: `${source.title} (fork)`.slice(0, 80),
      worktree: destinationWorktree,
      workspaceMode: destinationWorkspaceMode,
      provider: input.provider,
      parentThreadId: source.id,
      forkId,
      profileId: input.profileId,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      pinnedAt: null,
      archivedAt: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      wokeAt: null,
      lastVisitedAt: null,
    };
    const fork: ConversationFork = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      id: forkId,
      sourceThreadId: source.id,
      destinationThreadId: thread.id,
      provider: input.provider,
      profileId: input.profileId,
      model: input.model,
      worktree: destinationWorktree,
      status: "pending",
      messages,
      annotations,
      files: [],
      summaries: [],
      prompt,
      byteCount,
      createdAt: now,
      startedAt: null,
    };
    return this.#appendComputed((currentProjection) => {
      const currentSource = currentProjection.threads.find((item) => item.id === source.id);
      if (
        !currentSource ||
        currentSource.worktree !== source.worktree ||
        (currentSource.workspaceMode ?? "shared") !== (source.workspaceMode ?? "shared")
      ) {
        throw new LocalStateError("The source conversation changed after the fork preview.", 409);
      }
      const currentPreview = buildForkPreview(currentSource, currentProjection);
      if (currentPreview.digest !== input.expectedDigest) {
        throw new LocalStateError("The source context changed after the fork preview.", 409);
      }
      if (currentPreview.byteCount > 64 * 1024) {
        throw new LocalStateError("The reviewed context exceeds the 64 KiB fork limit.", 413);
      }
      if (
        destinationWorkspaceMode === "aldunis-managed" &&
        currentProjection.threads.some((item) => item.worktree === destinationWorktree)
      ) {
        throw new LocalStateError(
          "The fork destination worktree is already bound to another conversation.",
          409,
        );
      }
      if (
        currentProjection.threads.filter((item) => item.projectId === source.projectId).length >=
        MAX_THREADS_PER_PROJECT
      ) {
        throw new LocalStateError(
          `This project has reached the ${MAX_THREADS_PER_PROJECT}-conversation local retention limit.`,
          429,
        );
      }
      return { event: { type: "fork_created", thread, fork }, value: { thread, fork } };
    });
  }

  async previewFork(sourceThreadId: string): Promise<ReturnType<typeof buildForkPreview>> {
    const projection = await this.load();
    const source = projection.threads.find((thread) => thread.id === sourceThreadId);
    if (!source) throw new LocalStateError("The source conversation is unavailable.", 404);
    return buildForkPreview(source, projection);
  }

  async pendingForkPrompt(threadId: string): Promise<string | null> {
    const fork = (await this.load()).forks.find(
      (candidate) => candidate.destinationThreadId === threadId && candidate.status === "pending",
    );
    return fork?.prompt ?? null;
  }

  async markForkStarted(threadId: string): Promise<void> {
    const fork = (await this.load()).forks.find(
      (candidate) => candidate.destinationThreadId === threadId && candidate.status === "pending",
    );
    if (!fork) return;
    await this.#append({
      type: "fork_saved",
      fork: { ...fork, status: "started", startedAt: new Date().toISOString() },
    });
  }

  async bindProviderRun(turnId: string, providerRunId: string): Promise<void> {
    await this.#appendComputed((projection) => {
      const turn = projection.turns.find((item) => item.id === turnId);
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.", 404);
      const fire = projection.automationFires.find((item) => item.turnId === turnId);
      if (fire?.providerRunId && fire.providerRunId !== providerRunId) {
        throw new LocalStateError(
          "The automation fire is already bound to another provider run.",
          409,
        );
      }
      const events: StateEvent[] = [
        {
          type: "turn_saved",
          turn: { ...turn, providerRunId },
        },
      ];
      if (fire && fire.providerRunId !== providerRunId) {
        events.push({
          type: "automation_fire_saved",
          automationFire: {
            ...fire,
            providerRunId,
            updatedAt: new Date().toISOString(),
          },
        });
      }
      return { event: events, value: undefined };
    });
  }

  async getAutomationFire(automationId: string, key: string): Promise<AutomationFire | null> {
    const projection = await this.load();
    return (
      projection.automationFires.find(
        (fire) => fire.automationId === automationId && fire.key === key,
      ) ?? null
    );
  }

  async getAutomationFireById(fireId: string): Promise<AutomationFire | null> {
    const projection = await this.load();
    return projection.automationFires.find((fire) => fire.id === fireId) ?? null;
  }

  async latestAutomationFire(automationId: string): Promise<AutomationFire | null> {
    const projection = await this.load();
    return (
      projection.automationFires
        .filter((fire) => fire.automationId === automationId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
    );
  }

  async recordAutomationFireSkippedBusy(input: AutomationFireKey): Promise<AutomationFire> {
    return this.#appendComputed((projection) => {
      const existing = projection.automationFires.find(
        (fire) => fire.automationId === input.automationId && fire.key === input.key,
      );
      if (existing) return { event: null, value: existing };
      const now = new Date().toISOString();
      const fire: AutomationFire = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        automationId: input.automationId,
        key: input.key,
        kind: input.kind,
        scheduledAt: input.scheduledAt,
        requestedAt: input.requestedAt,
        turnId: null,
        providerRunId: null,
        status: "skipped_busy",
        error: null,
        retryOf: input.retryOf ?? null,
        createdAt: now,
        updatedAt: now,
      };
      return { event: { type: "automation_fire_saved", automationFire: fire }, value: fire };
    });
  }

  async claimAutomationFire(
    input: AutomationFireKey,
  ): Promise<{ fire: AutomationFire; claimed: boolean }> {
    return this.#appendComputed((projection) => {
      const existing = projection.automationFires.find(
        (fire) => fire.automationId === input.automationId && fire.key === input.key,
      );
      const now = new Date().toISOString();
      if (existing) {
        if (
          existing.kind !== "scheduled" ||
          existing.status !== "skipped_busy" ||
          existing.turnId
        ) {
          return { event: null, value: { fire: existing, claimed: false } };
        }
        const fire: AutomationFire = {
          ...existing,
          requestedAt: input.requestedAt,
          status: "started",
          error: null,
          updatedAt: now,
        };
        return {
          event: { type: "automation_fire_saved", automationFire: fire },
          value: { fire, claimed: true },
        };
      }
      const fire: AutomationFire = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        automationId: input.automationId,
        key: input.key,
        kind: input.kind,
        scheduledAt: input.scheduledAt,
        requestedAt: input.requestedAt,
        turnId: null,
        providerRunId: null,
        status: "started",
        error: null,
        retryOf: input.retryOf ?? null,
        createdAt: now,
        updatedAt: now,
      };
      return {
        event: { type: "automation_fire_saved", automationFire: fire },
        value: { fire, claimed: true },
      };
    });
  }

  async bindAutomationFireTurn(fireId: string, turnId: string): Promise<void> {
    await this.#appendComputed((projection) => {
      const fire = projection.automationFires.find((item) => item.id === fireId);
      if (!fire)
        throw new LocalStateError("The automation fire is missing from local history.", 404);
      if (fire.turnId && fire.turnId !== turnId) {
        throw new LocalStateError("The automation fire is already bound to another turn.", 409);
      }
      if (fire.turnId === turnId) return { event: null, value: undefined };
      const next: AutomationFire = {
        ...fire,
        turnId,
        updatedAt: new Date().toISOString(),
      };
      return { event: { type: "automation_fire_saved", automationFire: next }, value: undefined };
    });
  }

  async finishAutomationFire(
    fireId: string,
    status: AutomationFireTerminalStatus,
    error: string | null = null,
  ): Promise<AutomationFire> {
    return this.#appendComputed((projection) => {
      const fire = projection.automationFires.find((item) => item.id === fireId);
      if (!fire)
        throw new LocalStateError("The automation fire is missing from local history.", 404);
      if (fire.status !== "started" && fire.status !== "skipped_busy") {
        return { event: null, value: fire };
      }
      const safeError = error?.trim().slice(0, 500) || null;
      const next: AutomationFire = {
        ...fire,
        status,
        error: status === "completed" ? null : safeError,
        updatedAt: new Date().toISOString(),
      };
      return { event: { type: "automation_fire_saved", automationFire: next }, value: next };
    });
  }

  async automationFireOutcome(fireId: string): Promise<{
    status: AutomationFireTerminalStatus;
    error: string | null;
  }> {
    const projection = await this.load();
    const fire = projection.automationFires.find((item) => item.id === fireId);
    if (!fire) throw new LocalStateError("The automation fire is missing from local history.", 404);
    if (fire.status !== "started" && fire.status !== "skipped_busy") {
      return { status: fire.status, error: fire.error };
    }
    return automationFireOutcome(projection, fire);
  }

  async reconcileAutomationFires(): Promise<void> {
    await this.#appendComputed((projection) => {
      const events: StateEvent[] = [];
      for (const fire of projection.automationFires) {
        if (fire.status !== "started") continue;
        const outcome = automationFireOutcome(projection, fire);
        events.push({
          type: "automation_fire_saved",
          automationFire: {
            ...fire,
            status: outcome.status,
            error: outcome.error,
            updatedAt: new Date().toISOString(),
          },
        });
      }
      return { event: events, value: undefined };
    });
  }

  async saveAutonomyRecords(input: {
    runs?: AutonomyRun[];
    tasks?: AutonomyTask[];
    flows?: AutonomyFlow[];
    heartbeatMonitors?: HeartbeatMonitor[];
    standingOrders?: StandingOrder[];
    hooks?: AutonomyHook[];
  }): Promise<void> {
    await this.#appendComputed((projection) => {
      const events: StateEvent[] = [];
      const save = <T extends { id: string }>(items: T[], next: T, event: StateEvent) => {
        const existing = items.find((item) => item.id === next.id);
        if (existing && JSON.stringify(existing) === JSON.stringify(next)) return;
        events.push(event);
      };
      for (const run of input.runs ?? []) {
        save(projection.autonomyRuns, run, { type: "autonomy_run_saved", autonomyRun: run });
      }
      for (const task of input.tasks ?? []) {
        save(projection.autonomyTasks, task, { type: "autonomy_task_saved", autonomyTask: task });
      }
      for (const flow of input.flows ?? []) {
        save(projection.autonomyFlows, flow, { type: "autonomy_flow_saved", autonomyFlow: flow });
      }
      for (const monitor of input.heartbeatMonitors ?? []) {
        save(projection.heartbeatMonitors, monitor, {
          type: "heartbeat_monitor_saved",
          heartbeatMonitor: monitor,
        });
      }
      for (const order of input.standingOrders ?? []) {
        save(projection.standingOrders, order, {
          type: "standing_order_saved",
          standingOrder: order,
        });
      }
      for (const hook of input.hooks ?? []) {
        save(projection.autonomyHooks, hook, { type: "autonomy_hook_saved", autonomyHook: hook });
      }
      return { event: events, value: undefined };
    });
  }

  async removeAutonomyRecord(
    kind: "heartbeat" | "standingOrder" | "hook",
    id: string,
  ): Promise<void> {
    await this.#compact((projection) => {
      if (kind === "heartbeat") {
        const before = projection.heartbeatMonitors.length;
        projection.heartbeatMonitors = projection.heartbeatMonitors.filter(
          (item) => item.id !== id,
        );
        if (projection.heartbeatMonitors.length === before) {
          throw new LocalStateError("The heartbeat is unavailable.", 404);
        }
        return;
      }
      if (kind === "standingOrder") {
        const before = projection.standingOrders.length;
        projection.standingOrders = projection.standingOrders.filter((item) => item.id !== id);
        if (projection.standingOrders.length === before) {
          throw new LocalStateError("The standing order is unavailable.", 404);
        }
        return;
      }
      const before = projection.autonomyHooks.length;
      projection.autonomyHooks = projection.autonomyHooks.filter((item) => item.id !== id);
      if (projection.autonomyHooks.length === before) {
        throw new LocalStateError("The autonomy hook is unavailable.", 404);
      }
    });
  }

  async cancelAutonomyRun(runId: string): Promise<AutonomyRun> {
    return this.#appendComputed((projection) => {
      const run = projection.autonomyRuns.find((item) => item.id === runId);
      if (!run) throw new LocalStateError("The autonomy run is unavailable.", 404);
      if (["succeeded", "failed", "cancelled"].includes(run.status))
        return { event: null, value: run };
      const now = new Date().toISOString();
      const nextRun: AutonomyRun = {
        ...run,
        status: "cancelled",
        currentStepId: null,
        error: "Cancelled by the operator.",
        revision: run.revision + 1,
        updatedAt: now,
        completedAt: now,
      };
      const events: StateEvent[] = [{ type: "autonomy_run_saved", autonomyRun: nextRun }];
      for (const task of projection.autonomyTasks.filter((item) => item.runId === runId)) {
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(task.status)) continue;
        events.push({
          type: "autonomy_task_saved",
          autonomyTask: {
            ...task,
            status: "cancelled",
            error: "Cancelled with the parent autonomy run.",
            updatedAt: now,
            completedAt: now,
            nextRunAt: null,
          },
        });
      }
      return { event: events, value: nextRun };
    });
  }

  async resumeAutonomyRun(runId: string): Promise<AutonomyRun> {
    return this.#appendComputed((projection) => {
      const run = projection.autonomyRuns.find((item) => item.id === runId);
      if (!run) throw new LocalStateError("The autonomy run is unavailable.", 404);
      if (!["lost", "failed", "blocked", "waiting"].includes(run.status)) {
        throw new LocalStateError(
          "Only a paused, lost, blocked, or failed autonomy run can be resumed.",
          409,
        );
      }
      const now = new Date().toISOString();
      const nextRun: AutonomyRun = {
        ...run,
        status: "queued",
        trigger: "resume",
        error: null,
        revision: run.revision + 1,
        updatedAt: now,
        completedAt: null,
      };
      const events: StateEvent[] = [{ type: "autonomy_run_saved", autonomyRun: nextRun }];
      for (const task of projection.autonomyTasks.filter((item) => item.runId === runId)) {
        if (!["lost", "failed", "blocked", "waiting", "timed_out"].includes(task.status)) continue;
        events.push({
          type: "autonomy_task_saved",
          autonomyTask: {
            ...task,
            status: "queued",
            attempt: 0,
            error: null,
            output: null,
            startedAt: null,
            completedAt: null,
            nextRunAt: null,
            updatedAt: now,
          },
        });
      }
      return { event: events, value: nextRun };
    });
  }

  async recoverAutonomyRuns(): Promise<void> {
    await this.#appendComputed((projection) => {
      const now = new Date().toISOString();
      const events: StateEvent[] = [];
      const lostRunIds = new Set<string>();
      for (const run of projection.autonomyRuns) {
        if (run.status !== "running") continue;
        lostRunIds.add(run.id);
        events.push({
          type: "autonomy_run_saved",
          autonomyRun: {
            ...run,
            status: "lost",
            error: "The host stopped while this run was active; resume it explicitly.",
            revision: run.revision + 1,
            updatedAt: now,
          },
        });
      }
      for (const task of projection.autonomyTasks) {
        if (task.status !== "running" || !lostRunIds.has(task.runId)) continue;
        events.push({
          type: "autonomy_task_saved",
          autonomyTask: {
            ...task,
            status: "lost",
            error: "The host stopped while this task was active; resume the parent run explicitly.",
            updatedAt: now,
          },
        });
      }
      return { event: events, value: undefined };
    });
  }

  async renameConversation(threadId: string, title: string): Promise<Thread> {
    const thread = this.#requireThread(await this.load(), threadId);
    const trimmed = title.trim();
    if (!trimmed) throw new LocalStateError("A conversation title is required.", 400);
    const saved = { ...thread, title: trimmed.slice(0, 120), updatedAt: new Date().toISOString() };
    await this.#append({ type: "thread_saved", thread: saved });
    return saved;
  }

  async setConversationPinned(threadId: string, pinned: boolean): Promise<Thread> {
    const thread = this.#requireThread(await this.load(), threadId);
    const now = new Date().toISOString();
    const saved = { ...thread, pinnedAt: pinned ? now : null, updatedAt: now };
    await this.#append({ type: "thread_saved", thread: saved });
    return saved;
  }

  async archiveConversation(threadId: string): Promise<Thread> {
    const projection = await this.load();
    const thread = this.#requireThread(projection, threadId);
    this.#assertConversationSettled(projection, threadId, "archived");
    const now = new Date().toISOString();
    const saved = { ...thread, archivedAt: now, updatedAt: now };
    await this.#append({ type: "thread_saved", thread: saved });
    return saved;
  }

  async restoreConversation(threadId: string): Promise<Thread> {
    const thread = this.#requireThread(await this.load(), threadId);
    const saved = { ...thread, archivedAt: null, updatedAt: new Date().toISOString() };
    await this.#append({ type: "thread_saved", thread: saved });
    return saved;
  }

  /**
   * Sidebar settle: reversible, independent of archive, and never touches the worktree.
   * Idempotent — an already-settled thread is returned unchanged.
   * Settling clears any active snooze so presentation stays mutually exclusive.
   */
  async settleConversation(threadId: string): Promise<Thread> {
    return this.#appendComputed((projection) => {
      const thread = this.#requireThread(projection, threadId);
      this.#assertConversationSettled(projection, threadId, "settled");
      if (thread.settledAt && !thread.snoozedUntil && !thread.snoozedAt) {
        return { event: null, value: thread };
      }
      const now = new Date().toISOString();
      const saved = {
        ...thread,
        settledAt: thread.settledAt ?? now,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: now,
      };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  /** Clear settle. Idempotent — an unsettled thread is returned unchanged. */
  async unsettleConversation(threadId: string): Promise<Thread> {
    return this.#appendComputed((projection) => {
      const thread = this.#requireThread(projection, threadId);
      if (!thread.settledAt) return { event: null, value: thread };
      const saved = { ...thread, settledAt: null, updatedAt: new Date().toISOString() };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  /**
   * Temporary inbox hide until `snoozedUntil`. Visibility only: never archives,
   * never releases a worktree, and allows running provider work. Clears settle.
   * Rejects when the operator is blocked on approval or input.
   * Merges against the write-queue projection so concurrent provider updates
   * (wokeAt, etc.) are not clobbered by a stale whole-thread snapshot.
   */
  async snoozeConversation(threadId: string, snoozedUntilInput: string): Promise<Thread> {
    const wakeMs = Date.parse(snoozedUntilInput);
    if (Number.isNaN(wakeMs)) {
      throw new LocalStateError("A valid snooze wake time is required.", 400);
    }
    const requestedAt = Date.now();
    if (wakeMs <= requestedAt) {
      throw new LocalStateError("Snooze wake time must be in the future.", 400);
    }
    if (wakeMs - requestedAt > 60 * 24 * 60 * 60 * 1_000) {
      throw new LocalStateError("Snooze wake time must be within 60 days.", 400);
    }
    const snoozedUntil = new Date(wakeMs).toISOString();
    return this.#appendComputed((projection) => {
      const thread = this.#requireThread(projection, threadId);
      this.#assertConversationSnoozable(projection, threadId);
      const at = new Date().toISOString();
      if (thread.snoozedUntil === snoozedUntil && thread.snoozedAt && !thread.settledAt) {
        return { event: null, value: thread };
      }
      const saved = {
        ...thread,
        snoozedUntil,
        snoozedAt: at,
        settledAt: null,
        updatedAt: at,
      };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  /** Clear snooze. Idempotent — an unsnoozed thread is returned unchanged. */
  async unsnoozeConversation(threadId: string): Promise<Thread> {
    return this.#appendComputed((projection) => {
      const thread = this.#requireThread(projection, threadId);
      if (!thread.snoozedUntil && !thread.snoozedAt) {
        return { event: null, value: thread };
      }
      const saved = {
        ...thread,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: new Date().toISOString(),
      };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  async markConversationVisited(threadId: string): Promise<Thread> {
    const thread = this.#requireThread(await this.load(), threadId);
    const now = new Date().toISOString();
    // Visit is read-tracking only — do not bump updatedAt or the inbox resorts on every click.
    const saved = { ...thread, lastVisitedAt: now };
    await this.#append({ type: "thread_saved", thread: saved });
    return saved;
  }

  async previewConversationDeletion(
    threadId: string,
  ): Promise<ConversationDeletion["affectedRecords"]> {
    const projection = await this.load();
    this.#requireThread(projection, threadId);
    this.#assertConversationSettled(projection, threadId, "deleted");
    return this.#conversationRecordCounts(projection, threadId);
  }

  async linkDelegatedConversation(
    parentThreadId: string,
    childThreadId: string,
  ): Promise<DelegatedConversationRelationship> {
    return this.#appendComputed((projection) => {
      this.#requireThread(projection, parentThreadId);
      this.#requireThread(projection, childThreadId);
      if (parentThreadId === childThreadId) {
        throw new LocalStateError("A conversation cannot be delegated to itself.", 400);
      }
      const existing = projection.delegatedRelationships.find(
        (item) => item.childThreadId === childThreadId,
      );
      if (existing?.parentThreadId === parentThreadId) {
        return { event: null, value: existing };
      }
      if (existing) {
        throw new LocalStateError("This conversation already has a delegated parent.", 409);
      }
      if (
        wouldCreateDelegatedConversationCycle(
          projection.delegatedRelationships,
          parentThreadId,
          childThreadId,
        )
      ) {
        throw new LocalStateError("This delegated relationship would create a cycle.", 409);
      }
      const relationship: DelegatedConversationRelationship = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        parentThreadId,
        childThreadId,
        createdAt: new Date().toISOString(),
      };
      return {
        event: { type: "delegated_relationship_saved", delegatedRelationship: relationship },
        value: relationship,
      };
    });
  }

  async unlinkDelegatedConversation(parentThreadId: string, childThreadId: string): Promise<void> {
    const projection = await this.load();
    const relationship = projection.delegatedRelationships.find(
      (item) => item.parentThreadId === parentThreadId && item.childThreadId === childThreadId,
    );
    if (!relationship) {
      throw new LocalStateError("The delegated relationship is not available.", 404);
    }
    await this.#compact((next) => {
      next.delegatedRelationships = next.delegatedRelationships.filter(
        (item) => item.id !== relationship.id,
      );
    });
  }

  async resolveInputRequest(
    requestId: string,
    answer: string,
    parentThreadId: string | null,
  ): Promise<{ request: ChildInputRequest; receipt: ChildInputReceipt }> {
    await this.validateInputResponse(requestId, answer);
    const trimmed = answer.trim();
    let resolved: { request: ChildInputRequest; receipt: ChildInputReceipt } | null = null;
    await this.#compact((projection) => {
      const request = projection.inputRequests.find((item) => item.id === requestId);
      if (!request) throw new LocalStateError("The input request is not available.", 404);
      if (request.state !== "pending") {
        throw new LocalStateError("The input request has already been resolved.", 409);
      }
      if (!request.allowFreeForm && !request.choices.some((choice) => choice.label === trimmed)) {
        throw new LocalStateError("Select one of the available answers.", 400);
      }
      const turn = projection.turns.find(
        (item) => item.id === request.turnId && item.providerRunId === request.providerRunId,
      );
      if (!turn || turn.status !== "waiting_for_user") {
        throw new LocalStateError("The input request is stale.", 409);
      }
      const thread = projection.threads.find((item) => item.id === request.threadId);
      if (
        request.responseMode === "native_resume" &&
        thread?.provider === "shikigami" &&
        request.resumeState !== "available"
      ) {
        throw new LocalStateError(
          request.resumeError ?? "Native Shikigami resume is unavailable.",
          409,
        );
      }
      const now = new Date().toISOString();
      const nextRequest = {
        ...request,
        state: "answered" as const,
        answeredAt: now,
        ...(thread?.provider === "shikigami" && request.responseMode === "native_resume"
          ? { resumeState: "starting" as const, resumeError: null }
          : {}),
      };
      const receipt: ChildInputReceipt = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        requestId,
        childThreadId: request.threadId,
        parentThreadId,
        answerDigest: createHash("sha256").update(trimmed, "utf8").digest("hex"),
        route: request.responseMode,
        createdAt: now,
      };
      replaceById(projection.inputRequests, nextRequest);
      projection.inputReceipts.push(receipt);
      const hasOtherPendingInput = projection.inputRequests.some(
        (item) =>
          item.id !== requestId &&
          item.turnId === request.turnId &&
          item.providerRunId === request.providerRunId &&
          item.state === "pending",
      );
      replaceById(
        projection.turns,
        request.responseMode === "native_resume"
          ? { ...turn, status: hasOtherPendingInput ? "waiting_for_user" : "active" }
          : { ...turn, status: "completed", completedAt: now },
      );
      resolved = { request: nextRequest, receipt };
    });
    if (!resolved) throw new LocalStateError("The input request could not be resolved.");
    return resolved;
  }

  async validateInputResponse(requestId: string, answer: string): Promise<ChildInputRequest> {
    const trimmed = answer.trim();
    if (!trimmed || Array.from(trimmed).length > 4_000) {
      throw new LocalStateError("An answer between 1 and 4,000 characters is required.", 400);
    }
    const projection = await this.load();
    const request = projection.inputRequests.find((item) => item.id === requestId);
    if (!request) throw new LocalStateError("The input request is not available.", 404);
    if (request.state !== "pending") {
      throw new LocalStateError("The input request has already been resolved.", 409);
    }
    const thread = projection.threads.find((item) => item.id === request.threadId);
    if (
      request.responseMode === "native_resume" &&
      thread?.provider === "shikigami" &&
      request.resumeState !== "available"
    ) {
      throw new LocalStateError(
        request.resumeError ?? "Native Shikigami resume is unavailable.",
        409,
      );
    }
    if (!request.allowFreeForm && !request.choices.some((choice) => choice.label === trimmed)) {
      throw new LocalStateError("Select one of the available answers.", 400);
    }
    const turn = projection.turns.find(
      (item) => item.id === request.turnId && item.providerRunId === request.providerRunId,
    );
    if (!turn || turn.status !== "waiting_for_user") {
      throw new LocalStateError("The input request is stale.", 409);
    }
    return request;
  }

  async claimNativeShikigamiResume(
    requestId: string,
    threadId: string,
    resumeSessionId: string,
  ): Promise<{
    request: ChildInputRequest;
    thread: Thread;
    turn: Turn;
    checkpoint: TurnCheckpoint;
  }> {
    return this.#appendComputed((projection) => {
      const request = projection.inputRequests.find(
        (item) => item.id === requestId && item.threadId === threadId,
      );
      const thread = projection.threads.find((item) => item.id === threadId);
      const turn = request
        ? projection.turns.find((item) => item.id === request.turnId)
        : undefined;
      const checkpoint = request
        ? projection.checkpoints.find(
            (item) =>
              item.turnId === request.turnId &&
              item.threadId === threadId &&
              item.worktree === thread?.worktree &&
              item.state === "baseline",
          )
        : undefined;
      if (!request || !thread || !turn || !checkpoint) {
        throw new LocalStateError("The native Shikigami resume binding is unavailable.", 409);
      }
      if (
        request.state !== "answered" ||
        request.responseMode !== "native_resume" ||
        request.resumeState !== "starting" ||
        thread.provider !== "shikigami" ||
        request.providerRequestId !== resumeSessionId ||
        turn.providerRunId !== request.providerRunId ||
        !["active", "running"].includes(turn.status)
      ) {
        throw new LocalStateError(
          "The native Shikigami resume binding is stale or already claimed.",
          409,
        );
      }
      const claimed = {
        ...request,
        resumeState: "claimed" as const,
        resumeError: null,
      };
      return {
        event: { type: "input_request_saved", inputRequest: claimed },
        value: { request: claimed, thread, turn, checkpoint },
      };
    });
  }

  async markNativeShikigamiResumeStarted(requestId: string): Promise<void> {
    await this.#appendComputed((projection) => {
      const request = projection.inputRequests.find((item) => item.id === requestId);
      if (!request || request.responseMode !== "native_resume")
        return { event: null, value: undefined };
      if (request.resumeState === "started") return { event: null, value: undefined };
      if (request.resumeState !== "claimed") {
        throw new LocalStateError("The native Shikigami resume was not claimed.", 409);
      }
      return {
        event: {
          type: "input_request_saved",
          inputRequest: { ...request, resumeState: "started" as const, resumeError: null },
        },
        value: undefined,
      };
    });
  }

  async markNativeShikigamiResumeUnavailable(requestId: string): Promise<void> {
    const message = "Native Shikigami resume is unavailable.";
    await this.#appendComputed((projection) => {
      const request = projection.inputRequests.find((item) => item.id === requestId);
      if (!request || request.responseMode !== "native_resume") {
        return { event: null, value: undefined };
      }
      if (request.resumeState === "unavailable") return { event: null, value: undefined };
      if (!["starting", "claimed", "started"].includes(request.resumeState ?? "")) {
        return { event: null, value: undefined };
      }
      return {
        event: {
          type: "input_request_saved",
          inputRequest: {
            ...request,
            resumeState: "unavailable" as const,
            resumeError: message,
          },
        },
        value: undefined,
      };
    });
  }

  async failInputResolution(requestId: string): Promise<void> {
    await this.#compact((projection) => {
      const request = projection.inputRequests.find((item) => item.id === requestId);
      if (!request || request.state !== "answered") return;
      replaceById(projection.inputRequests, {
        ...request,
        state: "cancelled",
        answeredAt: null,
      });
      projection.inputReceipts = projection.inputReceipts.filter(
        (receipt) => receipt.requestId !== requestId,
      );
      const turn = projection.turns.find((item) => item.id === request.turnId);
      if (turn && !["failed", "interrupted", "cancelled"].includes(turn.status)) {
        replaceById(projection.turns, {
          ...turn,
          status: "interrupted",
          completedAt: new Date().toISOString(),
        });
      }
    });
  }

  async deleteConversation(threadId: string): Promise<ConversationDeletion> {
    const projection = await this.load();
    const existingDeletion = projection.conversationDeletions.find(
      (item) => item.threadId === threadId && item.status !== "completed",
    );
    const thread = projection.threads.find((item) => item.id === threadId);
    if (!thread && !existingDeletion) {
      throw new LocalStateError("The selected conversation is not available.", 404);
    }
    if (thread) this.#assertConversationSettled(projection, threadId, "deleted");
    const requestedAt = new Date().toISOString();
    const pending: ConversationDeletion = existingDeletion ?? {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      threadId,
      status: "pending",
      affectedRecords: this.#conversationRecordCounts(projection, threadId),
      requestedAt,
      completedAt: null,
      error: null,
    };
    await this.#append({
      type: "conversation_deletion_saved",
      conversationDeletion: { ...pending, status: "pending", error: null },
    });
    try {
      await this.#compact((next) => this.#removeConversationRecords(next, threadId));
      const completed: ConversationDeletion = {
        ...pending,
        status: "completed",
        completedAt: new Date().toISOString(),
      };
      await this.#append({ type: "conversation_deletion_saved", conversationDeletion: completed });
      return completed;
    } catch (error) {
      const failed: ConversationDeletion = {
        ...pending,
        status: "failed",
        error: error instanceof Error ? error.message : "Conversation compaction failed.",
      };
      await this.#append({ type: "conversation_deletion_saved", conversationDeletion: failed });
      throw new LocalStateError(
        "Conversation deletion is incomplete and can be retried. No repository or worktree was changed.",
      );
    }
  }

  #requireThread(projection: StateProjection, threadId: string): Thread {
    const thread = projection.threads.find((item) => item.id === threadId);
    if (!thread) throw new LocalStateError("The selected conversation is not available.", 404);
    return thread;
  }

  #assertConversationSettled(
    projection: StateProjection,
    threadId: string,
    action: "archived" | "deleted" | "settled",
  ): void {
    const blocking = projection.turns.find(
      (turn) =>
        turn.threadId === threadId &&
        ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(turn.status),
    );
    if (!blocking) return;
    const reason =
      blocking.status === "waiting_for_approval"
        ? "a tool approval is unresolved"
        : blocking.status === "waiting_for_user"
          ? "provider input is unresolved"
          : "provider work is active";
    throw new LocalStateError(
      `This conversation cannot be ${action} because ${reason}. Stop or resolve it, then retry.`,
      409,
    );
  }

  /**
   * Snooze hides the row only. Running turns may continue; unresolved approval
   * or input must stay visible so the operator is never asked in the dark.
   */
  #assertConversationSnoozable(projection: StateProjection, threadId: string): void {
    const blocking = projection.turns.find(
      (turn) =>
        turn.threadId === threadId &&
        (turn.status === "waiting_for_user" || turn.status === "waiting_for_approval"),
    );
    if (!blocking) return;
    const reason =
      blocking.status === "waiting_for_approval"
        ? "a tool approval is unresolved"
        : "provider input is unresolved";
    throw new LocalStateError(
      `This conversation cannot be snoozed because ${reason}. Resolve it, then retry.`,
      409,
    );
  }

  #conversationRecordCounts(
    projection: StateProjection,
    threadId: string,
  ): ConversationDeletion["affectedRecords"] {
    const turnIds = new Set(
      projection.turns.filter((turn) => turn.threadId === threadId).map((turn) => turn.id),
    );
    return {
      thread: projection.threads.some((thread) => thread.id === threadId) ? 1 : 0,
      turns: turnIds.size,
      messages: projection.messages.filter((message) => turnIds.has(message.turnId)).length,
      activities: projection.activities.filter((activity) => turnIds.has(activity.turnId)).length,
      plans: projection.plans.filter((plan) => plan.threadId === threadId).length,
      contextReceipts: projection.contextReceipts.filter((receipt) => receipt.threadId === threadId)
        .length,
      governanceCorrelations: projection.governanceCorrelations.filter(
        (receipt) => receipt.threadId === threadId,
      ).length,
      providerSessions: projection.providerSessions.filter(
        (session) => session.threadId === threadId,
      ).length,
      checkpoints: projection.checkpoints.filter((checkpoint) => checkpoint.threadId === threadId)
        .length,
      annotations: projection.annotations.filter((annotation) => annotation.threadId === threadId)
        .length,
      fileReviews: projection.fileReviews.filter((review) => review.threadId === threadId).length,
      forks: projection.forks.filter(
        (fork) => fork.sourceThreadId === threadId || fork.destinationThreadId === threadId,
      ).length,
      delegatedRelationships: projection.delegatedRelationships.filter(
        (relationship) =>
          relationship.parentThreadId === threadId || relationship.childThreadId === threadId,
      ).length,
      inputRequests: projection.inputRequests.filter((request) => request.threadId === threadId)
        .length,
      inputReceipts: projection.inputReceipts.filter(
        (receipt) => receipt.childThreadId === threadId || receipt.parentThreadId === threadId,
      ).length,
    };
  }

  #removeConversationRecords(projection: StateProjection, threadId: string): void {
    const turnIds = new Set(
      projection.turns.filter((turn) => turn.threadId === threadId).map((turn) => turn.id),
    );
    projection.threads = projection.threads.filter((thread) => thread.id !== threadId);
    projection.turns = projection.turns.filter((turn) => turn.threadId !== threadId);
    projection.automationFires = projection.automationFires.filter(
      (fire) => !fire.turnId || !turnIds.has(fire.turnId),
    );
    projection.messages = projection.messages.filter((message) => !turnIds.has(message.turnId));
    projection.activities = projection.activities.filter(
      (activity) => !turnIds.has(activity.turnId),
    );
    projection.plans = projection.plans.filter((plan) => plan.threadId !== threadId);
    projection.contextReceipts = projection.contextReceipts.filter(
      (receipt) => receipt.threadId !== threadId,
    );
    projection.governanceCorrelations = projection.governanceCorrelations.filter(
      (receipt) => receipt.threadId !== threadId,
    );
    projection.providerSessions = projection.providerSessions.filter(
      (session) => session.threadId !== threadId,
    );
    projection.checkpoints = projection.checkpoints.filter(
      (checkpoint) => checkpoint.threadId !== threadId,
    );
    projection.annotations = projection.annotations.filter(
      (annotation) => annotation.threadId !== threadId,
    );
    projection.fileReviews = projection.fileReviews.filter(
      (review) => review.threadId !== threadId,
    );
    const removedForkIds = new Set(
      projection.forks
        .filter((fork) => fork.sourceThreadId === threadId || fork.destinationThreadId === threadId)
        .map((fork) => fork.id),
    );
    projection.forks = projection.forks.filter((fork) => !removedForkIds.has(fork.id));
    projection.delegatedRelationships = projection.delegatedRelationships.filter(
      (relationship) =>
        relationship.parentThreadId !== threadId && relationship.childThreadId !== threadId,
    );
    const removedRequestIds = new Set(
      projection.inputRequests
        .filter((request) => request.threadId === threadId)
        .map((request) => request.id),
    );
    projection.inputRequests = projection.inputRequests.filter(
      (request) => !removedRequestIds.has(request.id),
    );
    projection.inputReceipts = projection.inputReceipts.filter(
      (receipt) =>
        !removedRequestIds.has(receipt.requestId) &&
        receipt.childThreadId !== threadId &&
        receipt.parentThreadId !== threadId,
    );
    projection.threads = projection.threads.map((thread) =>
      thread.parentThreadId === threadId || (thread.forkId && removedForkIds.has(thread.forkId))
        ? { ...thread, parentThreadId: undefined, forkId: undefined }
        : thread,
    );
  }

  async recoverInterruptedTurns(): Promise<void> {
    await this.#compact((current) => {
      for (const request of current.inputRequests) {
        if (request.state !== "answered" || request.responseMode !== "child_follow_up") continue;
        const receipt = current.inputReceipts.find((item) => item.requestId === request.id);
        if (!receipt) continue;
        const followUpPrefix = `Operator response to child input request ${request.id}:`;
        const persistedFollowUp = current.messages.some((message) => {
          if (message.role !== "user" || !message.text.startsWith(followUpPrefix)) return false;
          const turn = current.turns.find((item) => item.id === message.turnId);
          return turn?.threadId === request.threadId && message.createdAt >= receipt.createdAt;
        });
        if (persistedFollowUp) continue;
        replaceById(current.inputRequests, {
          ...request,
          state: "pending",
          answeredAt: null,
        });
        current.inputReceipts = current.inputReceipts.filter((item) => item.id !== receipt.id);
        const sourceTurn = current.turns.find((item) => item.id === request.turnId);
        if (sourceTurn) {
          replaceById(current.turns, {
            ...sourceTurn,
            status: "waiting_for_user",
            completedAt: null,
          });
        }
      }
      const unavailableMessage = "Native Shikigami resume is unavailable after the host restarted.";
      for (const request of current.inputRequests) {
        if (request.responseMode !== "native_resume") continue;
        const thread = current.threads.find((item) => item.id === request.threadId);
        if (thread?.provider !== "shikigami" || request.resumeState === "unavailable") continue;
        replaceById(current.inputRequests, {
          ...request,
          resumeState: "unavailable",
          resumeError: unavailableMessage,
        });
        const sourceTurn = current.turns.find((item) => item.id === request.turnId);
        if (
          sourceTurn &&
          ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(
            sourceTurn.status,
          )
        ) {
          replaceById(current.turns, {
            ...sourceTurn,
            status: "interrupted",
            completedAt: new Date().toISOString(),
          });
        }
      }
    });
    const projection = await this.load();
    for (const turn of projection.turns) {
      const nativeInputs =
        turn.status === "waiting_for_user"
          ? projection.inputRequests.filter(
              (request) =>
                request.turnId === turn.id &&
                request.state === "pending" &&
                request.responseMode === "native_resume" &&
                projection.threads.find((thread) => thread.id === turn.threadId)?.provider !==
                  "shikigami",
            )
          : [];
      if (
        turn.status !== "active" &&
        turn.status !== "running" &&
        turn.status !== "waiting_for_approval" &&
        nativeInputs.length === 0
      ) {
        continue;
      }
      for (const nativeInput of nativeInputs) {
        await this.#append({
          type: "input_request_saved",
          inputRequest: { ...nativeInput, state: "cancelled", answeredAt: null },
        });
      }
      await this.#append({
        type: "turn_saved",
        turn: {
          ...turn,
          status: "interrupted",
          completedAt: new Date().toISOString(),
        },
      });
    }
  }

  async #markThreadWoke(threadId: string, at: string): Promise<void> {
    const thread = (await this.load()).threads.find((item) => item.id === threadId);
    if (!thread) return;
    if (thread.wokeAt === at) return;
    await this.#append({
      type: "thread_saved",
      thread: { ...thread, wokeAt: at, updatedAt: at },
    });
  }

  async recordProviderEvent(
    threadId: string,
    turnId: string,
    provider: ProviderId,
    event: ProviderEvent,
    providerBinding?: { profileId: string; continuationKey: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    if (event.kind === "browser_observation") {
      if (event.provider !== provider) {
        throw new LocalStateError(
          "The browser observation provider does not match the active provider.",
          502,
        );
      }
      // Screenshots are sensitive provider output. They are stream-only UI
      // state: never append them to local history, activity, or checkpoints.
      return;
    }
    if (event.kind === "input_requested") {
      const turn = (await this.load()).turns.find((item) => item.id === turnId);
      if (!turn || !turn.providerRunId) {
        throw new LocalStateError("The provider turn is missing its run binding.");
      }
      if (!["active", "running", "waiting_for_user"].includes(turn.status)) return;
      const request: ChildInputRequest = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: event.id,
        threadId,
        turnId,
        providerRunId: turn.providerRunId,
        question: event.question.slice(0, 1_000),
        choices: event.choices.slice(0, 12).map((choice) => ({
          id: choice.id.slice(0, 100),
          label: choice.label.slice(0, 200),
          description: choice.description?.slice(0, 500) ?? null,
        })),
        recommendation: event.recommendation?.slice(0, 500) ?? null,
        responseMode: event.responseMode,
        providerRequestId: event.providerRequestId,
        expiresAt: event.expiresAt,
        allowFreeForm: event.allowFreeForm,
        ...(provider === "shikigami" &&
        event.responseMode === "native_resume" &&
        event.providerRequestId
          ? { resumeState: "available" as const, resumeError: null }
          : {}),
        state: "pending",
        createdAt: now,
        answeredAt: null,
      };
      await this.#append({ type: "input_request_saved", inputRequest: request });
      if (turn.status !== "waiting_for_user") {
        await this.#append({
          type: "turn_saved",
          turn: { ...turn, status: "waiting_for_user" },
        });
      }
      await this.#markThreadWoke(threadId, now);
      return;
    }
    if (event.kind === "input_resolved") {
      const projection = await this.load();
      const request = projection.inputRequests.find(
        (item) => item.id === event.id && item.threadId === threadId,
      );
      const turn = projection.turns.find((item) => item.id === turnId);
      if (!request || request.state !== "pending" || !turn) return;
      await this.#append({
        type: "input_request_saved",
        inputRequest: {
          ...request,
          state: event.state === "answered" ? "answered" : "cancelled",
          answeredAt: event.state === "answered" ? now : null,
        },
      });
      if (!["completed", "failed", "interrupted", "cancelled"].includes(turn.status)) {
        const hasOtherPendingInput = projection.inputRequests.some(
          (item) =>
            item.id !== request.id &&
            item.turnId === request.turnId &&
            item.providerRunId === request.providerRunId &&
            item.state === "pending",
        );
        await this.#append({
          type: "turn_saved",
          turn: { ...turn, status: hasOtherPendingInput ? "waiting_for_user" : "active" },
        });
      }
      return;
    }
    if (event.kind === "approval_pending" || event.kind === "approval_resolved") {
      const turn = (await this.load()).turns.find((item) => item.id === turnId);
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      if (["completed", "failed", "interrupted", "cancelled"].includes(turn.status)) {
        return;
      }
      const nextStatus =
        event.kind === "approval_pending" && event.state === "pending"
          ? ("waiting_for_approval" as const)
          : ("active" as const);
      await this.#append({
        type: "turn_saved",
        turn: {
          ...turn,
          status: nextStatus,
        },
      });
      if (nextStatus === "waiting_for_approval") {
        await this.#markThreadWoke(threadId, now);
      }
      return;
    }
    if (event.kind === "assistant_text") {
      await this.#append({
        type: "message_saved",
        message: {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          id: randomUUID(),
          turnId,
          role: "assistant",
          text: event.text,
          createdAt: now,
        },
      });
      return;
    }
    if (event.kind === "thinking") {
      // Provider reasoning is a live-only projection. It must not enter the
      // durable transcript, fork context, delegated outcome, or local journal.
      return;
    }
    if (event.kind === "context_usage") {
      // Context pressure is live-only for the composer meter. Do not journal
      // token counts into durable history or fork context.
      return;
    }
    if (event.kind === "plan_updated") {
      const projection = await this.load();
      const turn = projection.turns.find(
        (item) => item.id === turnId && item.threadId === threadId,
      );
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      if (event.artifact.provider !== provider) {
        throw new LocalStateError("The plan artifact provider does not match the active provider.");
      }
      const id = createHash("sha256")
        .update(`${threadId}\n${turnId}\n${provider}\n${event.artifact.id}`, "utf8")
        .digest("hex");
      const existing = projection.plans.find((plan) => plan.id === id);
      const body =
        event.artifact.body === undefined
          ? existing?.body
          : event.bodyMode === "append"
            ? `${existing?.body ?? ""}${event.artifact.body}`
            : event.artifact.body;
      await this.#append({
        type: "plan_saved",
        plan: {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          id,
          artifactId: event.artifact.id,
          threadId,
          turnId,
          provider,
          ...(event.artifact.title !== undefined
            ? { title: event.artifact.title }
            : existing?.title !== undefined
              ? { title: existing.title }
              : {}),
          ...(body !== undefined ? { body } : {}),
          ...(event.artifact.steps !== undefined
            ? { steps: event.artifact.steps }
            : existing?.steps !== undefined
              ? { steps: existing.steps }
              : {}),
          createdAt: existing?.createdAt ?? now,
          updatedAt: event.artifact.updatedAt ?? now,
          eventSequence: existing?.eventSequence,
        },
      });
      return;
    }
    if (event.kind === "governance_correlation") {
      if (
        provider !== "shikigami" ||
        event.governance !== "sekai-chisei" ||
        event.operationId !== event.runId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.runId)
      ) {
        throw new LocalStateError("The provider governance correlation is incompatible.", 502);
      }
      const projection = await this.load();
      const turn = projection.turns.find(
        (item) => item.id === turnId && item.threadId === threadId,
      );
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      const existing = projection.governanceCorrelations.find(
        (receipt) => receipt.turnId === turnId,
      );
      if (
        existing &&
        (existing.runId !== event.runId || existing.operationId !== event.operationId)
      ) {
        throw new LocalStateError(
          "The provider reported conflicting governance correlations.",
          502,
        );
      }
      if (existing) return;
      const id = createHash("sha256")
        .update(`${threadId}\n${turnId}\n${event.runId}`, "utf8")
        .digest("hex");
      await this.#append({
        type: "governance_correlation_saved",
        governanceCorrelation: {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          id,
          provider: "shikigami",
          governance: "sekai-chisei",
          threadId,
          turnId,
          runId: event.runId,
          operationId: event.operationId,
          createdAt: now,
        },
      });
      return;
    }
    if (event.kind === "session_started" || event.kind === "turn_completed") {
      const current = (await this.load()).providerSessions.find(
        (item) => item.threadId === threadId && item.provider === provider,
      );
      await this.#append({
        type: "provider_session_saved",
        providerSession: {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          threadId,
          provider,
          sessionId: event.sessionId,
          model: event.kind === "session_started" ? event.model : (current?.model ?? null),
          ...((providerBinding?.profileId ?? current?.profileId)
            ? { profileId: providerBinding?.profileId ?? current?.profileId }
            : {}),
          ...((providerBinding?.continuationKey ?? current?.continuationKey)
            ? { continuationKey: providerBinding?.continuationKey ?? current?.continuationKey }
            : {}),
          updatedAt: now,
        },
      });
    }
    if (
      event.kind === "tool_started" ||
      event.kind === "tool_finished" ||
      event.kind === "failed"
    ) {
      await this.#append({
        type: "activity_saved",
        activity: {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          id: randomUUID(),
          turnId,
          kind: event.kind === "failed" ? "provider_failed" : event.kind,
          toolCallId: event.kind === "failed" ? null : event.toolCallId,
          name: event.kind === "tool_started" ? event.name : null,
          failed:
            event.kind === "tool_finished" ? event.failed : event.kind === "failed" ? true : null,
          // Never persist arbitrary failure text — it can contain credentials
          // or subprocess dumps. Only repository-owned, typed diagnostics are
          // durable; every other failure restores a generic label.
          message: event.kind === "failed" ? persistedProviderFailureMessage(event) : null,
          createdAt: now,
        },
      });
    }
    if (event.kind === "turn_completed" || event.kind === "cancelled" || event.kind === "failed") {
      const projection = await this.load();
      const turn = projection.turns.find((item) => item.id === turnId);
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      const nextStatus =
        event.kind === "turn_completed"
          ? ("completed" as const)
          : event.kind === "cancelled"
            ? ("interrupted" as const)
            : ("failed" as const);
      await this.#append({
        type: "turn_saved",
        turn: {
          ...turn,
          status: nextStatus,
          completedAt: now,
        },
      });
      for (const request of projection.inputRequests.filter(
        (item) => item.turnId === turnId && item.state === "pending",
      )) {
        await this.#append({
          type: "input_request_saved",
          inputRequest: { ...request, state: "cancelled", answeredAt: null },
        });
      }
      if (nextStatus === "failed") {
        await this.#markThreadWoke(threadId, now);
      }
    }
  }

  async saveCheckpoint(
    checkpoint: Omit<TurnCheckpoint, "schemaVersion" | "updatedAt">,
  ): Promise<TurnCheckpoint> {
    const saved: TurnCheckpoint = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      ...checkpoint,
      updatedAt: new Date().toISOString(),
    };
    await this.#append({ type: "checkpoint_saved", checkpoint: saved });
    return saved;
  }

  async saveAnnotation(
    annotation: Omit<DiffAnnotation, "schemaVersion" | "updatedAt">,
  ): Promise<DiffAnnotation> {
    const thread = (await this.load()).threads.find((item) => item.id === annotation.threadId);
    if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
    const saved: DiffAnnotation = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      ...annotation,
      updatedAt: new Date().toISOString(),
    };
    await this.#append({ type: "annotation_saved", annotation: saved });
    return saved;
  }

  async setAnnotationResolution(
    annotationId: string,
    threadId: string,
    resolution: AnnotationResolution,
  ): Promise<DiffAnnotation> {
    const annotation = (await this.load()).annotations.find(
      (item) => item.id === annotationId && item.threadId === threadId,
    );
    if (!annotation) throw new LocalStateError("The annotation is unavailable.", 404);
    return this.saveAnnotation({ ...annotation, resolution });
  }

  async setFileReview(input: {
    threadId: string;
    path: string;
    previousPath?: string | null;
    diffIdentity: string;
    reviewed: boolean;
  }): Promise<FileReview> {
    const projection = await this.load();
    const thread = projection.threads.find((item) => item.id === input.threadId);
    if (!thread) throw new LocalStateError("The review conversation is unavailable.", 404);
    const path = input.path.trim();
    const diffIdentity = input.diffIdentity.trim();
    if (!path || !diffIdentity) {
      throw new LocalStateError("A file path and content identity are required.", 400);
    }
    const now = new Date().toISOString();
    const existing = projection.fileReviews.find(
      (item) =>
        item.threadId === input.threadId &&
        item.path === path &&
        item.diffIdentity === diffIdentity,
    );
    const saved: FileReview = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      id: existing?.id ?? randomUUID(),
      threadId: input.threadId,
      path,
      previousPath: input.previousPath ?? existing?.previousPath ?? null,
      diffIdentity,
      reviewed: input.reviewed,
      reviewedAt: input.reviewed
        ? existing?.reviewed && existing.reviewedAt
          ? existing.reviewedAt
          : now
        : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#append({ type: "file_review_saved", fileReview: saved });
    return saved;
  }

  async supersedeCompletedCheckpoints(
    threadId: string,
    worktree: string,
    exceptId: string,
  ): Promise<void> {
    const projection = await this.load();
    for (const checkpoint of projection.checkpoints) {
      if (
        checkpoint.threadId === threadId &&
        checkpoint.worktree === worktree &&
        checkpoint.id !== exceptId &&
        checkpoint.state === "completed"
      ) {
        await this.saveCheckpoint({ ...checkpoint, state: "superseded" });
      }
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.#compact((projection) => {
      const threadIds = new Set(
        projection.threads
          .filter((thread) => thread.projectId === projectId)
          .map((thread) => thread.id),
      );
      const turnIds = new Set(
        projection.turns.filter((turn) => threadIds.has(turn.threadId)).map((turn) => turn.id),
      );
      projection.projects = projection.projects.filter((project) => project.id !== projectId);
      projection.threads = projection.threads.filter((thread) => !threadIds.has(thread.id));
      projection.turns = projection.turns.filter((turn) => !turnIds.has(turn.id));
      projection.automationFires = projection.automationFires.filter(
        (fire) => !fire.turnId || !turnIds.has(fire.turnId),
      );
      projection.messages = projection.messages.filter((message) => !turnIds.has(message.turnId));
      projection.activities = projection.activities.filter(
        (activity) => !turnIds.has(activity.turnId),
      );
      projection.plans = projection.plans.filter((plan) => !threadIds.has(plan.threadId));
      projection.contextReceipts = projection.contextReceipts.filter(
        (receipt) => !threadIds.has(receipt.threadId),
      );
      projection.governanceCorrelations = projection.governanceCorrelations.filter(
        (receipt) => !threadIds.has(receipt.threadId),
      );
      projection.providerSessions = projection.providerSessions.filter(
        (session) => !threadIds.has(session.threadId),
      );
      projection.checkpoints = projection.checkpoints.filter(
        (checkpoint) => !threadIds.has(checkpoint.threadId),
      );
      projection.annotations = projection.annotations.filter(
        (annotation) => !threadIds.has(annotation.threadId),
      );
      projection.fileReviews = projection.fileReviews.filter(
        (review) => !threadIds.has(review.threadId),
      );
      projection.forks = projection.forks.filter(
        (fork) => !threadIds.has(fork.sourceThreadId) && !threadIds.has(fork.destinationThreadId),
      );
      projection.delegatedRelationships = projection.delegatedRelationships.filter(
        (relationship) =>
          !threadIds.has(relationship.parentThreadId) && !threadIds.has(relationship.childThreadId),
      );
      const requestIds = new Set(
        projection.inputRequests
          .filter((request) => threadIds.has(request.threadId))
          .map((request) => request.id),
      );
      projection.inputRequests = projection.inputRequests.filter(
        (request) => !requestIds.has(request.id),
      );
      projection.inputReceipts = projection.inputReceipts.filter(
        (receipt) =>
          !requestIds.has(receipt.requestId) &&
          !threadIds.has(receipt.childThreadId) &&
          (!receipt.parentThreadId || !threadIds.has(receipt.parentThreadId)),
      );
      const deletedRunIds = new Set(
        projection.autonomyRuns.filter((run) => run.projectId === projectId).map((run) => run.id),
      );
      projection.autonomyRuns = projection.autonomyRuns.filter((run) => !deletedRunIds.has(run.id));
      projection.autonomyTasks = projection.autonomyTasks.filter(
        (task) => !deletedRunIds.has(task.runId),
      );
      projection.heartbeatMonitors = projection.heartbeatMonitors.filter(
        (monitor) => monitor.projectId !== projectId,
      );
      projection.standingOrders = projection.standingOrders.filter(
        (order) => order.projectId !== projectId,
      );
      projection.autonomyHooks = projection.autonomyHooks.filter(
        (hook) => hook.projectId !== projectId,
      );
    });
  }

  async enforceRetention(olderThan: Date): Promise<void> {
    await this.#compact((projection) => {
      const protectedByFork = new Set(
        projection.forks.flatMap((fork) => [fork.sourceThreadId, fork.destinationThreadId]),
      );
      const expiredThreads = new Set(
        projection.threads
          .filter(
            (thread) => new Date(thread.updatedAt) < olderThan && !protectedByFork.has(thread.id),
          )
          .map((thread) => thread.id),
      );
      const expiredTurns = new Set(
        projection.turns.filter((turn) => expiredThreads.has(turn.threadId)).map((turn) => turn.id),
      );
      projection.threads = projection.threads.filter((thread) => !expiredThreads.has(thread.id));
      projection.turns = projection.turns.filter((turn) => !expiredTurns.has(turn.id));
      projection.automationFires = projection.automationFires.filter(
        (fire) => !fire.turnId || !expiredTurns.has(fire.turnId),
      );
      projection.messages = projection.messages.filter(
        (message) => !expiredTurns.has(message.turnId),
      );
      projection.activities = projection.activities.filter(
        (activity) => !expiredTurns.has(activity.turnId),
      );
      projection.plans = projection.plans.filter((plan) => !expiredThreads.has(plan.threadId));
      projection.contextReceipts = projection.contextReceipts.filter(
        (receipt) => !expiredThreads.has(receipt.threadId),
      );
      projection.governanceCorrelations = projection.governanceCorrelations.filter(
        (receipt) => !expiredThreads.has(receipt.threadId),
      );
      projection.providerSessions = projection.providerSessions.filter(
        (session) => !expiredThreads.has(session.threadId),
      );
      projection.checkpoints = projection.checkpoints.filter(
        (checkpoint) => !expiredThreads.has(checkpoint.threadId),
      );
      projection.annotations = projection.annotations.filter(
        (annotation) => !expiredThreads.has(annotation.threadId),
      );
      projection.fileReviews = projection.fileReviews.filter(
        (review) => !expiredThreads.has(review.threadId),
      );
      projection.forks = projection.forks.filter(
        (fork) =>
          !expiredThreads.has(fork.sourceThreadId) && !expiredThreads.has(fork.destinationThreadId),
      );
      projection.delegatedRelationships = projection.delegatedRelationships.filter(
        (relationship) =>
          !expiredThreads.has(relationship.parentThreadId) &&
          !expiredThreads.has(relationship.childThreadId),
      );
      const requestIds = new Set(
        projection.inputRequests
          .filter((request) => expiredThreads.has(request.threadId))
          .map((request) => request.id),
      );
      projection.inputRequests = projection.inputRequests.filter(
        (request) => !requestIds.has(request.id),
      );
      projection.inputReceipts = projection.inputReceipts.filter(
        (receipt) =>
          !requestIds.has(receipt.requestId) &&
          !expiredThreads.has(receipt.childThreadId) &&
          (!receipt.parentThreadId || !expiredThreads.has(receipt.parentThreadId)),
      );
    });
  }

  async #compact(change: (projection: StateProjection) => void): Promise<void> {
    await this.load();
    const operation = this.#writeQueue.then(async () => {
      const next = structuredClone(this.#projection);
      change(next);
      const transcriptEvents = [
        ...next.messages.map((message) => ({
          eventSequence: message.eventSequence,
          createdAt: message.createdAt,
          event: { type: "message_saved" as const, message },
        })),
        ...next.activities.map((activity) => ({
          eventSequence: activity.eventSequence,
          createdAt: activity.createdAt,
          event: { type: "activity_saved" as const, activity },
        })),
        ...next.plans.map((plan) => ({
          eventSequence: plan.eventSequence,
          createdAt: plan.createdAt,
          event: {
            type: "plan_saved" as const,
            plan: { ...plan, eventSequence: undefined },
          },
        })),
        ...next.contextReceipts.map((contextReceipt) => ({
          eventSequence: undefined,
          createdAt: contextReceipt.createdAt,
          event: { type: "context_receipt_saved" as const, contextReceipt },
        })),
        ...next.governanceCorrelations.map((governanceCorrelation) => ({
          eventSequence: undefined,
          createdAt: governanceCorrelation.createdAt,
          event: {
            type: "governance_correlation_saved" as const,
            governanceCorrelation,
          },
        })),
      ].sort((left, right) =>
        left.eventSequence !== undefined && right.eventSequence !== undefined
          ? left.eventSequence - right.eventSequence
          : left.createdAt.localeCompare(right.createdAt),
      );
      const events: StateEvent[] = [
        ...next.projects.map((project): StateEvent => ({ type: "project_saved", project })),
        ...next.threads.map((thread): StateEvent => ({ type: "thread_saved", thread })),
        ...next.turns.map((turn): StateEvent => ({ type: "turn_saved", turn })),
        ...transcriptEvents.map(({ event }) => event),
        ...next.providerSessions.map((providerSession): StateEvent => ({
          type: "provider_session_saved",
          providerSession,
        })),
        ...next.checkpoints.map((checkpoint): StateEvent => ({
          type: "checkpoint_saved",
          checkpoint,
        })),
        ...next.annotations.map((annotation): StateEvent => ({
          type: "annotation_saved",
          annotation,
        })),
        ...next.fileReviews.map((fileReview): StateEvent => ({
          type: "file_review_saved",
          fileReview,
        })),
        ...next.conversationDeletions.map((conversationDeletion): StateEvent => ({
          type: "conversation_deletion_saved",
          conversationDeletion,
        })),
        ...next.forks.map((fork): StateEvent => ({ type: "fork_saved", fork })),
        ...next.delegatedRelationships.map((delegatedRelationship): StateEvent => ({
          type: "delegated_relationship_saved",
          delegatedRelationship,
        })),
        ...next.inputRequests.map((inputRequest): StateEvent => ({
          type: "input_request_saved",
          inputRequest,
        })),
        ...next.inputReceipts.map((inputReceipt): StateEvent => ({
          type: "input_receipt_saved",
          inputReceipt,
        })),
        ...next.automationFires.map((automationFire): StateEvent => ({
          type: "automation_fire_saved",
          automationFire,
        })),
        ...next.autonomyRuns.map((autonomyRun): StateEvent => ({
          type: "autonomy_run_saved",
          autonomyRun,
        })),
        ...next.autonomyTasks.map((autonomyTask): StateEvent => ({
          type: "autonomy_task_saved",
          autonomyTask,
        })),
        ...next.autonomyFlows.map((autonomyFlow): StateEvent => ({
          type: "autonomy_flow_saved",
          autonomyFlow,
        })),
        ...next.heartbeatMonitors.map((heartbeatMonitor): StateEvent => ({
          type: "heartbeat_monitor_saved",
          heartbeatMonitor,
        })),
        ...next.standingOrders.map((standingOrder): StateEvent => ({
          type: "standing_order_saved",
          standingOrder,
        })),
        ...next.autonomyHooks.map((autonomyHook): StateEvent => ({
          type: "autonomy_hook_saved",
          autonomyHook,
        })),
      ];
      const rebuilt = emptyProjection();
      const envelopes = events.map((event, index) => {
        const envelope: EventEnvelope = {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          sequence: index + 1,
          id: randomUUID(),
          recordedAt: new Date().toISOString(),
          event,
        };
        applyEvent(rebuilt, envelope);
        return envelope;
      });
      await this.#replaceHistory(envelopes);
      this.#projection = rebuilt;
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}
