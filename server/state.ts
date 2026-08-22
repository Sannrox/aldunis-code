import { createHash, randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  appendAssistantTextChunkWithWhitespaceState,
  joinAssistantTextChunks,
} from "../src/lib/assistant-text.ts";
import { wouldCreateDelegatedConversationCycle } from "../src/lib/delegated-conversation-graph.ts";
import {
  MAX_USAGE_COST_USD,
  MAX_USAGE_TOKENS,
  type UsageReceipt,
  type UsageReceiptStatus,
} from "../src/lib/usage.ts";
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
  MAX_AUTONOMY_CONFIGURATIONS_PER_KIND,
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
export const MAX_EVENT_HISTORY_WRITE_BUFFER_BYTES = 256 * 1024;
/** Fail-closed ceiling for one JSONL event record (line body, excluding newline). */
export const MAX_EVENT_ENVELOPE_BYTES = 8 * 1024 * 1024;
export const HOST_WRITER_TARGET = "host-writer";
export const HOST_WRITER_LOCK = "host-writer.lock";
export const HOST_WRITER_LEASE_IDENTITY = "lease.json";
const WRITER_LEASE_IDENTITY_GRACE_MS = 100;
const WRITER_LEASE_STALE_MS = 30_000;
const WRITER_LEASE_UPDATE_MS = 10_000;
const MAX_WRITER_LEASE_IDENTITY_BYTES = 1024;

interface WriterLeaseIdentity {
  pid: number;
  hostname: string;
  createdAt: string;
  starttime?: string | null;
}

export interface LocalStateStoreOptions {
  /**
   * Test-only seam: pause after opening history so concurrent first loads can
   * interleave with later appends before initialization finishes.
   */
  holdHistoryRead?: () => Promise<void>;
  /**
   * Test-only seam: count write-queue admissions without waiting for fsync.
   */
  onWriteEnqueued?: () => void;
  /**
   * Test-only seam: pause at the start of each write-queue job so callers can
   * observe live inspect state while a journal write is in flight.
   */
  holdWrite?: () => Promise<void>;
}

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
    usageReceipts: number;
    governanceCorrelations: number;
    providerSessions: number;
    checkpoints: number;
    annotations: number;
    fileReviews: number;
    forks: number;
    delegatedRelationships: number;
    inputRequests: number;
    inputReceipts: number;
    mailboxTransfers: number;
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

export interface MailboxTransfer {
  schemaVersion: 2;
  id: string;
  sourceThreadId: string;
  destinationThreadId: string;
  text: string;
  mode: InteractionMode;
  createdAt: string;
  destinationTurnId: string | null;
  idempotencyKey: string;
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
  usageReceipts: UsageReceipt[];
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
  mailboxTransfers: MailboxTransfer[];
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
  | {
      type: "message_text_appended";
      messageTextAppend: {
        schemaVersion: 2;
        id: string;
        turnId: string;
        offset: number;
        text: string;
      };
    }
  | { type: "activity_saved"; activity: Activity }
  | { type: "plan_saved"; plan: PlanArtifact }
  | { type: "context_receipt_saved"; contextReceipt: ContextReceipt }
  | { type: "usage_receipt_saved"; usageReceipt: UsageReceipt }
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
  | { type: "mailbox_transfer_saved"; mailboxTransfer: MailboxTransfer }
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
    usageReceipts: [],
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
    mailboxTransfers: [],
    automationFires: [],
    autonomyRuns: [],
    autonomyTasks: [],
    autonomyFlows: [],
    heartbeatMonitors: [],
    standingOrders: [],
    autonomyHooks: [],
  };
}

/**
 * Isolate every mutable collection for a journal rewrite while sharing the
 * immutable records it contains. Rewrite callbacks must replace records rather
 * than mutate them in place.
 */
export function isolateProjectionCollections(projection: StateProjection): StateProjection {
  return {
    ...projection,
    projects: [...projection.projects],
    threads: [...projection.threads],
    turns: [...projection.turns],
    messages: [...projection.messages],
    activities: [...projection.activities],
    plans: [...projection.plans],
    contextReceipts: [...projection.contextReceipts],
    usageReceipts: [...projection.usageReceipts],
    governanceCorrelations: [...projection.governanceCorrelations],
    providerSessions: [...projection.providerSessions],
    checkpoints: [...projection.checkpoints],
    annotations: [...projection.annotations],
    fileReviews: [...projection.fileReviews],
    conversationDeletions: [...projection.conversationDeletions],
    forks: [...projection.forks],
    delegatedRelationships: [...projection.delegatedRelationships],
    inputRequests: [...projection.inputRequests],
    inputReceipts: [...projection.inputReceipts],
    mailboxTransfers: [...projection.mailboxTransfers],
    automationFires: [...projection.automationFires],
    autonomyRuns: [...projection.autonomyRuns],
    autonomyTasks: [...projection.autonomyTasks],
    autonomyFlows: [...projection.autonomyFlows],
    heartbeatMonitors: [...projection.heartbeatMonitors],
    standingOrders: [...projection.standingOrders],
    autonomyHooks: [...projection.autonomyHooks],
  };
}

type AutomationFireTerminalStatus = Exclude<AutomationFireStatus, "started" | "skipped_busy">;

function automationFireOutcome(
  projection: StateProjection,
  fire: AutomationFire,
  turnById?: ReadonlyMap<string, Turn>,
): { status: AutomationFireTerminalStatus; error: string | null } {
  const turn = fire.turnId
    ? turnById
      ? turnById.get(fire.turnId)
      : projection.turns.find((item) => item.id === fire.turnId)
    : undefined;
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
const BUSY_TURN_STATUSES = new Set<Turn["status"]>([
  "active",
  "running",
  "waiting_for_user",
  "waiting_for_approval",
]);

export function projectThreadStatus(
  projection: StateProjection,
  threadId: string,
  turnsByThread?: TurnsByThreadIndex,
): ThreadStatusProjection {
  const thread = projection.threads.find((item) => item.id === threadId);
  const turns =
    turnsByThread?.get(threadId) ?? projection.turns.filter((turn) => turn.threadId === threadId);
  return projectThreadStatusFromTurns(thread, turns, threadId);
}

function projectThreadStatusFromTurns(
  thread: Thread | undefined,
  turns: readonly Turn[],
  threadId: string,
): ThreadStatusProjection {
  let latest: Turn | undefined;
  let approval: Turn | undefined;
  let awaiting: Turn | undefined;
  let running: Turn | undefined;
  for (const turn of turns) {
    if (!latest || turn.createdAt >= latest.createdAt) latest = turn;
    if (
      turn.status === "waiting_for_approval" &&
      (!approval || turn.createdAt >= approval.createdAt)
    ) {
      approval = turn;
    }
    if (turn.status === "waiting_for_user" && (!awaiting || turn.createdAt >= awaiting.createdAt)) {
      awaiting = turn;
    }
    if (
      (turn.status === "active" || turn.status === "running") &&
      (!running || turn.createdAt >= running.createdAt)
    ) {
      running = turn;
    }
  }
  if (approval) {
    return {
      threadId,
      status: "pending_approval",
      since:
        thread?.wokeAt && thread.wokeAt >= approval.createdAt ? thread.wokeAt : approval.createdAt,
    };
  }
  if (awaiting) {
    return {
      threadId,
      status: "awaiting_input",
      since:
        thread?.wokeAt && thread.wokeAt >= awaiting.createdAt ? thread.wokeAt : awaiting.createdAt,
    };
  }
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

export type TurnsByThreadIndex = ReadonlyMap<string, readonly Turn[]>;
export type DelegatedMessagesByTurnIndex = ReadonlyMap<string, ReadonlyMap<string, Message>>;
export type DelegatedActivitiesByTurnIndex = ReadonlyMap<string, ReadonlyMap<string, Activity>>;
type RowsByThread<T> = ReadonlyMap<string, readonly T[]>;
export interface ConversationHistoryIndex {
  revisionByThread: ReadonlyMap<string, number>;
  threadById: ReadonlyMap<string, Thread>;
  turnByProviderRunId: ReadonlyMap<string, Turn>;
  turnsByThread: TurnsByThreadIndex;
  messagesByThread: RowsByThread<Message>;
  activitiesByThread: RowsByThread<Activity>;
  plansByThread: RowsByThread<Plan>;
  contextReceiptsByThread: RowsByThread<ContextReceipt>;
  usageReceiptsByThread: RowsByThread<UsageReceipt>;
  inputRequestsByThread: RowsByThread<InputRequest>;
  inputRequestById: ReadonlyMap<string, InputRequest>;
  providerSessionsByThread: RowsByThread<ProviderSession>;
  conversationDeletionByThread: ReadonlyMap<string, ConversationDeletion>;
  forkByDestinationThread: ReadonlyMap<string, ConversationFork>;
  annotationById: ReadonlyMap<string, DiffAnnotation>;
  fileReviewByIdentity: ReadonlyMap<string, FileReview>;
  automationFireById: ReadonlyMap<string, AutomationFire>;
  automationFireByKey: ReadonlyMap<string, AutomationFire>;
  automationFireByTurnId: ReadonlyMap<string, AutomationFire>;
  delegatedRelationshipByChild: ReadonlyMap<string, DelegatedConversationRelationship>;
  mailboxTransfersByThread: RowsByThread<MailboxTransfer>;
  mailboxTransferById: ReadonlyMap<string, MailboxTransfer>;
  mailboxTransferByKey: ReadonlyMap<string, MailboxTransfer>;
  governanceCorrelationsByThread: RowsByThread<GovernanceCorrelation>;
  checkpointsByThread: RowsByThread<Checkpoint>;
}
export interface WorkbenchProjectionIndexes {
  projection: Readonly<StateProjection>;
  turnsByThread: TurnsByThreadIndex;
  delegatedMessagesByTurn: DelegatedMessagesByTurnIndex;
  delegatedActivitiesByTurn: DelegatedActivitiesByTurnIndex;
  conversationHistory: ConversationHistoryIndex;
}

interface ProviderEventContext {
  thread: Thread | undefined;
  turn: Turn | undefined;
  inputRequests: readonly InputRequest[];
  plans: readonly Plan[];
  usageReceipts: readonly UsageReceipt[];
  governanceCorrelations: readonly GovernanceCorrelation[];
  providerSessions: readonly ProviderSession[];
}

interface MutableConversationHistoryIndex extends ConversationHistoryIndex {
  revisionByThread: Map<string, number>;
  threadById: Map<string, Thread>;
  turnByProviderRunId: Map<string, Turn>;
  turnsByThread: Map<string, Turn[]>;
  messagesByThread: Map<string, Message[]>;
  activitiesByThread: Map<string, Activity[]>;
  plansByThread: Map<string, Plan[]>;
  contextReceiptsByThread: Map<string, ContextReceipt[]>;
  usageReceiptsByThread: Map<string, UsageReceipt[]>;
  inputRequestsByThread: Map<string, InputRequest[]>;
  inputRequestById: Map<string, InputRequest>;
  providerSessionsByThread: Map<string, ProviderSession[]>;
  conversationDeletionByThread: Map<string, ConversationDeletion>;
  forkByDestinationThread: Map<string, ConversationFork>;
  annotationById: Map<string, DiffAnnotation>;
  fileReviewByIdentity: Map<string, FileReview>;
  automationFireById: Map<string, AutomationFire>;
  automationFireByKey: Map<string, AutomationFire>;
  automationFireByTurnId: Map<string, AutomationFire>;
  delegatedRelationshipByChild: Map<string, DelegatedConversationRelationship>;
  mailboxTransfersByThread: Map<string, MailboxTransfer[]>;
  mailboxTransferById: Map<string, MailboxTransfer>;
  mailboxTransferByKey: Map<string, MailboxTransfer>;
  governanceCorrelationsByThread: Map<string, GovernanceCorrelation[]>;
  checkpointsByThread: Map<string, Checkpoint[]>;
  threadIdByTurn: Map<string, string>;
}

function groupRowsByThread<T>(rows: readonly T[], threadId: (row: T) => string): Map<string, T[]> {
  const rowsByThread = new Map<string, T[]>();
  for (const row of rows) {
    const id = threadId(row);
    const group = rowsByThread.get(id);
    if (group) group.push(row);
    else rowsByThread.set(id, [row]);
  }
  return rowsByThread;
}

function indexMailboxTransfersByThread(
  transfers: readonly MailboxTransfer[],
): Map<string, MailboxTransfer[]> {
  const rowsByThread = new Map<string, MailboxTransfer[]>();
  for (const transfer of transfers) {
    for (const threadId of [transfer.sourceThreadId, transfer.destinationThreadId]) {
      const group = rowsByThread.get(threadId);
      if (group) {
        if (!group.some((item) => item.id === transfer.id)) group.push(transfer);
      } else rowsByThread.set(threadId, [transfer]);
    }
  }
  return rowsByThread;
}

function indexSavedMailboxTransfer(
  rowsByThread: Map<string, MailboxTransfer[]>,
  previous: MailboxTransfer | undefined,
  transfer: MailboxTransfer,
): void {
  if (previous) {
    for (const threadId of [previous.sourceThreadId, previous.destinationThreadId]) {
      const group = rowsByThread.get(threadId);
      if (!group) continue;
      const next = group.filter((item) => item.id !== previous.id);
      if (next.length > 0) rowsByThread.set(threadId, next);
      else rowsByThread.delete(threadId);
    }
  }
  for (const threadId of [transfer.sourceThreadId, transfer.destinationThreadId]) {
    const group = rowsByThread.get(threadId) ?? [];
    rowsByThread.set(threadId, [...group.filter((item) => item.id !== transfer.id), transfer]);
  }
}

function fileReviewIdentity(
  review: Pick<FileReview, "threadId" | "path" | "diffIdentity">,
): string {
  return `${review.threadId}\0${review.path}\0${review.diffIdentity}`;
}

function automationFireIdentity(fire: Pick<AutomationFire, "automationId" | "key">): string {
  return `${fire.automationId}\0${fire.key}`;
}

function buildConversationHistoryIndex(
  projection: StateProjection,
  turnsByThread = groupTurnsByThread(projection.turns),
): MutableConversationHistoryIndex {
  const threadIdByTurn = new Map(projection.turns.map((turn) => [turn.id, turn.threadId]));
  const threadForTurn = (row: { turnId: string }) => threadIdByTurn.get(row.turnId) ?? "";
  return {
    // Rebuilds conservatively invalidate every conversation once. Subsequent
    // live events advance only the exact history they can change.
    revisionByThread: new Map(projection.threads.map((thread) => [thread.id, projection.sequence])),
    threadById: new Map(projection.threads.map((thread) => [thread.id, thread])),
    turnByProviderRunId: new Map(
      projection.turns.flatMap((turn) =>
        turn.providerRunId ? ([[turn.providerRunId, turn]] as const) : [],
      ),
    ),
    turnsByThread,
    messagesByThread: groupRowsByThread(projection.messages, threadForTurn),
    activitiesByThread: groupRowsByThread(projection.activities, threadForTurn),
    plansByThread: groupRowsByThread(projection.plans, (row) => row.threadId),
    contextReceiptsByThread: groupRowsByThread(projection.contextReceipts, (row) => row.threadId),
    usageReceiptsByThread: groupRowsByThread(projection.usageReceipts, (row) => row.threadId),
    inputRequestsByThread: groupRowsByThread(projection.inputRequests, (row) => row.threadId),
    inputRequestById: new Map(projection.inputRequests.map((request) => [request.id, request])),
    providerSessionsByThread: groupRowsByThread(projection.providerSessions, (row) => row.threadId),
    conversationDeletionByThread: new Map(
      projection.conversationDeletions.map((deletion) => [deletion.threadId, deletion]),
    ),
    forkByDestinationThread: new Map(
      projection.forks.map((fork) => [fork.destinationThreadId, fork]),
    ),
    annotationById: new Map(
      projection.annotations.map((annotation) => [annotation.id, annotation]),
    ),
    fileReviewByIdentity: new Map(
      projection.fileReviews.map((review) => [fileReviewIdentity(review), review]),
    ),
    automationFireById: new Map(projection.automationFires.map((fire) => [fire.id, fire])),
    automationFireByKey: new Map(
      projection.automationFires.map((fire) => [automationFireIdentity(fire), fire]),
    ),
    automationFireByTurnId: new Map(
      projection.automationFires.flatMap((fire) => (fire.turnId ? [[fire.turnId, fire]] : [])),
    ),
    delegatedRelationshipByChild: new Map(
      projection.delegatedRelationships.map((relationship) => [
        relationship.childThreadId,
        relationship,
      ]),
    ),
    mailboxTransfersByThread: indexMailboxTransfersByThread(projection.mailboxTransfers),
    mailboxTransferById: new Map(
      projection.mailboxTransfers.map((transfer) => [transfer.id, transfer]),
    ),
    mailboxTransferByKey: new Map(
      projection.mailboxTransfers.map((transfer) => [transfer.idempotencyKey, transfer]),
    ),
    governanceCorrelationsByThread: groupRowsByThread(
      projection.governanceCorrelations,
      (row) => row.threadId,
    ),
    checkpointsByThread: groupRowsByThread(projection.checkpoints, (row) => row.threadId),
    threadIdByTurn,
  };
}

function groupTurnsByThread(turns: readonly Turn[]): Map<string, Turn[]> {
  const turnsByThread = new Map<string, Turn[]>();
  for (const turn of turns) {
    const group = turnsByThread.get(turn.threadId);
    if (group) group.push(turn);
    else turnsByThread.set(turn.threadId, [turn]);
  }
  return turnsByThread;
}

/**
 * Batch thread status from a store-maintained turn index when provided.
 * Without an index this still groups `projection.turns` once; `/api/state/load`
 * must pass the live index so refresh does not scan unrelated conversations.
 */
export function projectThreadStatuses(
  projection: Pick<StateProjection, "threads" | "turns">,
  turnsByThread?: TurnsByThreadIndex,
): ThreadStatusProjection[] {
  const index = turnsByThread ?? groupTurnsByThread(projection.turns);
  return projection.threads.map((thread) =>
    projectThreadStatusFromTurns(thread, index.get(thread.id) ?? [], thread.id),
  );
}

function rememberLatestCompletedTurn(latestByChild: Map<string, Turn>, turn: Turn): void {
  if (turn.status !== "completed") return;
  const previous = latestByChild.get(turn.threadId);
  if (
    !previous ||
    turn.createdAt > previous.createdAt ||
    (turn.createdAt === previous.createdAt && turn.id > previous.id)
  ) {
    latestByChild.set(turn.threadId, turn);
  }
}

export function projectDelegatedConversationOutcomes(
  projection: StateProjection,
  turnsByThread?: TurnsByThreadIndex,
  messagesByTurn?: DelegatedMessagesByTurnIndex,
  activitiesByTurn?: DelegatedActivitiesByTurnIndex,
): DelegatedConversationOutcomeProjection[] {
  const childIds = new Set(
    projection.delegatedRelationships.map((relationship) => relationship.childThreadId),
  );
  const latestByChild = new Map<string, Turn>();
  if (turnsByThread) {
    for (const childId of childIds) {
      const turns = turnsByThread.get(childId);
      if (!turns) continue;
      for (const turn of turns) rememberLatestCompletedTurn(latestByChild, turn);
    }
  } else {
    for (const turn of projection.turns) {
      if (!childIds.has(turn.threadId)) continue;
      rememberLatestCompletedTurn(latestByChild, turn);
    }
  }
  const childByTurn = new Map(
    [...latestByChild].map(([childThreadId, turn]) => [turn.id, childThreadId]),
  );
  const lastToolStartByTurn = new Map<string, number>();
  const indexedRows = function* <T>(
    turnIds: Iterable<string>,
    rowsByTurn: ReadonlyMap<string, ReadonlyMap<string, T>>,
  ): Generator<T> {
    for (const turnId of turnIds) {
      yield* rowsByTurn.get(turnId)?.values() ?? [];
    }
  };
  const relevantActivities = activitiesByTurn
    ? indexedRows(childByTurn.keys(), activitiesByTurn)
    : projection.activities;
  for (const activity of relevantActivities) {
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
    characters: string[];
    start: number;
    truncated: boolean;
    pendingWhitespace: string;
  };
  const appendBoundedTail = (current: BoundedSummary | undefined, next: string): BoundedSummary => {
    if (!next.trim()) {
      const whitespace = `${current?.pendingWhitespace ?? ""}${next}`;
      return {
        characters: current?.characters ?? [],
        start: current?.start ?? 0,
        truncated: current?.truncated ?? false,
        pendingWhitespace: whitespace.includes("\n") ? "\n\n" : " ",
      };
    }
    const substantive = next.trimEnd();
    const trailingWhitespace = next.slice(substantive.length);
    const characters = current?.characters ?? [];
    let start = current?.start ?? 0;
    const previous = characters.at(-1);
    const pendingWhitespace = current?.pendingWhitespace ?? "";
    if (pendingWhitespace) characters.push(...pendingWhitespace);
    else if (
      previous !== undefined &&
      !/\s/.test(previous) &&
      /^(#{1,6}(?=\s|#|$)|```|---(?:\s|$))/.test(substantive)
    ) {
      characters.push("\n");
    }
    for (const character of substantive) characters.push(character);
    const overflow = characters.length - start - 500;
    const truncated = Boolean(current?.truncated) || overflow > 0;
    if (overflow > 0) start += overflow;
    if (start >= 1_024 && start * 2 >= characters.length) {
      characters.splice(0, start);
      start = 0;
    }
    return {
      characters,
      start,
      truncated,
      pendingWhitespace: trailingWhitespace.includes("\n") ? "\n\n" : trailingWhitespace,
    };
  };
  const allAssistantByChild = new Map<string, BoundedSummary>();
  const finalAssistantByChild = new Map<string, BoundedSummary>();
  const relevantMessages = messagesByTurn
    ? indexedRows(childByTurn.keys(), messagesByTurn)
    : projection.messages;
  for (const message of relevantMessages) {
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
    const finalText = finalAssistant
      ? finalAssistant.characters.slice(finalAssistant.start).join("")
      : "";
    const projected = finalText.trim() ? finalAssistant : allAssistantByChild.get(childThreadId);
    const summary = projected ? projected.characters.slice(projected.start).join("").trim() : "";
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

type ReplayIndexes = Map<unknown[], Map<string, number>>;

function replayIndex<T extends { id: string }>(
  items: T[],
  indexes: ReplayIndexes,
): Map<string, number> {
  let index = indexes.get(items);
  if (!index) {
    index = new Map(items.map((item, itemIndex) => [item.id, itemIndex]));
    indexes.set(items, index);
  }
  return index;
}

function replaceByIdDuringReplay<T extends { id: string }>(
  items: T[],
  value: T,
  indexes?: ReplayIndexes,
): void {
  if (!indexes) {
    replaceById(items, value);
    return;
  }
  const index = replayIndex(items, indexes);
  const existing = index.get(value.id);
  if (existing === undefined) {
    index.set(value.id, items.length);
    items.push(value);
  } else {
    items[existing] = value;
  }
}

/**
 * ACP streams (Grok, Kiro, …) historically persisted many tiny assistant_text
 * rows. For fork transfer and the exact-messages review list, join consecutive
 * assistant chunks so the operator sees readable replies rather than token rows.
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
      previous.text = joinAssistantTextChunks([previous.text, message.text]);
      continue;
    }
    coalesced.push({ ...message });
  }
  return coalesced;
}

function transcriptOrderKey(item: {
  eventSequence?: number;
  createdAt: string;
  id: string;
}): [number, string, string] {
  return [item.eventSequence ?? Number.MAX_SAFE_INTEGER, item.createdAt, item.id];
}

function compareTranscriptOrder(
  left: { eventSequence?: number; createdAt: string; id: string },
  right: { eventSequence?: number; createdAt: string; id: string },
): number {
  const leftKey = transcriptOrderKey(left);
  const rightKey = transcriptOrderKey(right);
  if (leftKey[0] !== rightKey[0]) return leftKey[0] - rightKey[0];
  if (leftKey[1] !== rightKey[1]) return leftKey[1].localeCompare(rightKey[1]);
  return leftKey[2].localeCompare(rightKey[2]);
}

/**
 * Collapse consecutive assistant stream chunks that have no activity between
 * them. Preserves user messages and assistant segments split by tools.
 * Used when rewriting history so older token-per-event logs shrink.
 */
function coalescedAssistantMessageCount(messages: Message[], activities: Activity[]): number {
  let count = 0;
  let openTurnId: string | null = null;
  let messageIndex = 0;
  let activityIndex = 0;
  while (messageIndex < messages.length || activityIndex < activities.length) {
    const message = messages[messageIndex];
    const activity = activities[activityIndex];
    if (activity && (!message || compareTranscriptOrder(activity, message) < 0)) {
      activityIndex += 1;
      openTurnId = null;
    } else if (message?.role !== "assistant") {
      messageIndex += 1;
      count += 1;
      openTurnId = null;
    } else if (openTurnId !== message.turnId) {
      messageIndex += 1;
      count += 1;
      openTurnId = message.turnId;
    } else {
      messageIndex += 1;
    }
  }
  return count;
}

export function coalesceConsecutiveAssistantMessages(
  messages: Message[],
  activities: Activity[],
): Message[] {
  if (messages.length <= 1) return messages.map((message) => ({ ...message }));
  const coalesced: Message[] = [];
  let open: Message | null = null;
  let openTextParts: string[] = [];
  const closeOpen = () => {
    if (open) {
      open.text = joinAssistantTextChunks(openTextParts);
      coalesced.push(open);
      open = null;
      openTextParts = [];
    }
  };
  let messageIndex = 0;
  let activityIndex = 0;
  while (messageIndex < messages.length || activityIndex < activities.length) {
    const message = messages[messageIndex];
    const activity = activities[activityIndex];
    if (activity && (!message || compareTranscriptOrder(activity, message) < 0)) {
      activityIndex += 1;
      closeOpen();
      continue;
    }
    if (!message) break;
    messageIndex += 1;
    if (message.role !== "assistant") {
      closeOpen();
      coalesced.push({ ...message });
      continue;
    }
    if (open && open.turnId === message.turnId) {
      openTextParts.push(message.text);
      // Keep the earliest sequence so intervening activities remain after the
      // segment start when history is rebuilt.
      open.eventSequence ??= message.eventSequence;
      continue;
    }
    closeOpen();
    open = { ...message };
    openTextParts = [message.text];
  }
  closeOpen();
  return coalesced;
}

type RewriteTranscriptRecord =
  Message | Activity | PlanArtifact | ContextReceipt | UsageReceipt | GovernanceCorrelationReceipt;

function* rewriteTranscriptEvents(projection: StateProjection): Generator<StateEvent> {
  const collections: readonly (readonly RewriteTranscriptRecord[])[] = [
    projection.messages,
    projection.activities,
    projection.plans,
    projection.contextReceipts,
    projection.usageReceipts,
    projection.governanceCorrelations,
  ];
  // Replay appends a record on its first event and replaces it in place on
  // later events. Rewrite mutations only filter or immutably replace records,
  // so each collection retains its event/timestamp order. Validate that
  // invariant before relying on the allocation-bounded merge.
  for (const collection of collections) {
    for (let index = 1; index < collection.length; index += 1) {
      if (compareRewriteTranscriptOrder(collection[index - 1]!, collection[index]!) > 0) {
        throw new LocalStateError("Local transcript collections are not ordered for rewrite.");
      }
    }
  }
  const positions = new Uint32Array(collections.length);
  while (true) {
    let selected = -1;
    for (let index = 0; index < collections.length; index += 1) {
      const candidate = collections[index][positions[index]];
      if (!candidate) continue;
      const current = selected < 0 ? undefined : collections[selected][positions[selected]];
      if (!current || compareRewriteTranscriptOrder(candidate, current) < 0) selected = index;
    }
    if (selected < 0) return;
    const record = collections[selected][positions[selected]++]!;
    if (selected === 0) yield { type: "message_saved", message: record as Message };
    else if (selected === 1) yield { type: "activity_saved", activity: record as Activity };
    else if (selected === 2) {
      yield {
        type: "plan_saved",
        plan: { ...(record as PlanArtifact), eventSequence: undefined },
      };
    } else if (selected === 3) {
      yield { type: "context_receipt_saved", contextReceipt: record as ContextReceipt };
    } else if (selected === 4) {
      yield { type: "usage_receipt_saved", usageReceipt: record as UsageReceipt };
    } else {
      yield {
        type: "governance_correlation_saved",
        governanceCorrelation: record as GovernanceCorrelationReceipt,
      };
    }
  }
}

function compareRewriteTranscriptOrder(
  left: RewriteTranscriptRecord,
  right: RewriteTranscriptRecord,
): number {
  const leftSequence = "eventSequence" in left ? left.eventSequence : undefined;
  const rightSequence = "eventSequence" in right ? right.eventSequence : undefined;
  return leftSequence !== undefined && rightSequence !== undefined
    ? leftSequence - rightSequence
    : left.createdAt.localeCompare(right.createdAt);
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

function previousTurnDuringApply(
  turns: Turn[],
  turnId: string,
  replayIndexes?: ReplayIndexes,
): Turn | undefined {
  if (replayIndexes) {
    const index = replayIndex(turns, replayIndexes).get(turnId);
    return index === undefined ? undefined : turns[index];
  }
  return turns.find((turn) => turn.id === turnId);
}

function indexSavedTurn(
  turnsByThread: Map<string, Turn[]>,
  previous: Turn | undefined,
  next: Turn,
): void {
  if (previous && previous.threadId !== next.threadId) {
    const oldBucket = turnsByThread.get(previous.threadId);
    if (oldBucket) {
      const oldIndex = oldBucket.findIndex((turn) => turn.id === previous.id);
      if (oldIndex !== -1) oldBucket.splice(oldIndex, 1);
      if (oldBucket.length === 0) turnsByThread.delete(previous.threadId);
    }
  }
  const bucket = turnsByThread.get(next.threadId);
  if (!bucket) {
    turnsByThread.set(next.threadId, [next]);
    return;
  }
  const existingIndex = bucket.findIndex((turn) => turn.id === next.id);
  if (existingIndex === -1) bucket.push(next);
  else bucket[existingIndex] = next;
}

function indexSavedRow<T extends { id: string; turnId: string }>(
  rowsByTurn: Map<string, Map<string, T>>,
  next: T,
): void {
  const bucket = rowsByTurn.get(next.turnId);
  if (!bucket) rowsByTurn.set(next.turnId, new Map([[next.id, next]]));
  else bucket.set(next.id, next);
}

function indexSavedThreadRow<T extends { id: string }>(
  rowsByThread: Map<string, T[]>,
  threadId: string,
  next: T,
): void {
  const bucket = rowsByThread.get(threadId);
  if (!bucket) {
    rowsByThread.set(threadId, [next]);
    return;
  }
  const index = bucket.findIndex((row) => row.id === next.id);
  if (index === -1) bucket.push(next);
  else bucket[index] = next;
}

function indexSavedProviderSession(
  sessionsByThread: Map<string, ProviderSession[]>,
  next: ProviderSession,
): void {
  const bucket = sessionsByThread.get(next.threadId);
  if (!bucket) {
    sessionsByThread.set(next.threadId, [next]);
    return;
  }
  const index = bucket.findIndex((session) => session.provider === next.provider);
  if (index === -1) bucket.push(next);
  else bucket[index] = next;
}

function indexSavedDelegatedRelationship(
  relationshipByChild: Map<string, DelegatedConversationRelationship>,
  previous: DelegatedConversationRelationship | undefined,
  next: DelegatedConversationRelationship,
): void {
  if (previous && previous.childThreadId !== next.childThreadId) {
    relationshipByChild.delete(previous.childThreadId);
  }
  relationshipByChild.set(next.childThreadId, next);
}

function removeIndexedThreadRow<T extends { id: string }>(
  rowsByThread: Map<string, T[]>,
  threadId: string,
  rowId: string,
): void {
  const bucket = rowsByThread.get(threadId);
  if (!bucket) return;
  const remaining = bucket.filter((row) => row.id !== rowId);
  if (remaining.length === 0) rowsByThread.delete(threadId);
  else if (remaining.length !== bucket.length) rowsByThread.set(threadId, remaining);
}

function rebuildDelegatedTranscriptIndexes(
  projection: StateProjection,
  messagesByTurn: Map<string, Map<string, Message>>,
  activitiesByTurn: Map<string, Map<string, Activity>>,
  delegatedChildTurnIds: Set<string>,
): void {
  messagesByTurn.clear();
  activitiesByTurn.clear();
  delegatedChildTurnIds.clear();
  const childThreadIds = new Set(
    projection.delegatedRelationships.map((relationship) => relationship.childThreadId),
  );
  for (const turn of projection.turns) {
    if (childThreadIds.has(turn.threadId)) delegatedChildTurnIds.add(turn.id);
  }
  for (const message of projection.messages) {
    if (delegatedChildTurnIds.has(message.turnId)) indexSavedRow(messagesByTurn, message);
  }
  for (const activity of projection.activities) {
    if (delegatedChildTurnIds.has(activity.turnId)) indexSavedRow(activitiesByTurn, activity);
  }
}

function historyThreadIdForEvent(
  event: StateEvent,
  history: MutableConversationHistoryIndex,
): string | null {
  switch (event.type) {
    case "thread_saved":
      return event.thread.id;
    case "fork_created":
      return event.thread.id;
    case "turn_saved":
      return event.turn.threadId;
    case "message_saved":
      return history.threadIdByTurn.get(event.message.turnId) ?? null;
    case "message_text_appended":
      return history.threadIdByTurn.get(event.messageTextAppend.turnId) ?? null;
    case "activity_saved":
      return history.threadIdByTurn.get(event.activity.turnId) ?? null;
    case "plan_saved":
      return event.plan.threadId;
    case "context_receipt_saved":
      return event.contextReceipt.threadId;
    case "governance_correlation_saved":
      return event.governanceCorrelation.threadId;
    case "provider_session_saved":
      return event.providerSession.threadId;
    case "checkpoint_saved":
      return event.checkpoint.threadId;
    case "input_request_saved":
      return event.inputRequest.threadId;
    default:
      return null;
  }
}

function applyEvent(
  projection: StateProjection,
  envelope: EventEnvelope,
  replayIndexes?: ReplayIndexes,
  turnsByThread?: Map<string, Turn[]>,
  messagesByTurn?: Map<string, Map<string, Message>>,
  activitiesByTurn?: Map<string, Map<string, Activity>>,
  delegatedChildTurnIds?: Set<string>,
  deferDelegatedIndexBuild = false,
  conversationHistory?: MutableConversationHistoryIndex,
): void {
  if (envelope.sequence !== projection.sequence + 1) {
    throw new LocalStateError(
      `Local history is not ordered at event ${envelope.sequence}; expected ${projection.sequence + 1}.`,
    );
  }
  const event = envelope.event;
  if (event.type === "project_saved")
    replaceByIdDuringReplay(projection.projects, event.project, replayIndexes);
  else if (event.type === "thread_saved") {
    replaceByIdDuringReplay(projection.threads, event.thread, replayIndexes);
    conversationHistory?.threadById.set(event.thread.id, event.thread);
  } else if (event.type === "turn_saved") {
    const previous = previousTurnDuringApply(projection.turns, event.turn.id, replayIndexes);
    replaceByIdDuringReplay(projection.turns, event.turn, replayIndexes);
    if (turnsByThread) indexSavedTurn(turnsByThread, previous, event.turn);
    if (conversationHistory) {
      if (previous?.providerRunId && previous.providerRunId !== event.turn.providerRunId) {
        conversationHistory.turnByProviderRunId.delete(previous.providerRunId);
      }
      if (event.turn.providerRunId) {
        conversationHistory.turnByProviderRunId.set(event.turn.providerRunId, event.turn);
      }
      conversationHistory.threadIdByTurn.set(event.turn.id, event.turn.threadId);
      if (conversationHistory.turnsByThread !== turnsByThread)
        indexSavedTurn(conversationHistory.turnsByThread, previous, event.turn);
    }
    if (
      delegatedChildTurnIds &&
      projection.delegatedRelationships.some(
        (relationship) => relationship.childThreadId === event.turn.threadId,
      )
    ) {
      delegatedChildTurnIds.add(event.turn.id);
    }
  } else if (event.type === "message_saved") {
    const next = { ...event.message, eventSequence: envelope.sequence };
    replaceByIdDuringReplay(projection.messages, next, replayIndexes);
    const threadId = conversationHistory?.threadIdByTurn.get(next.turnId);
    if (conversationHistory && threadId)
      indexSavedThreadRow(conversationHistory.messagesByThread, threadId, next);
    if (messagesByTurn && delegatedChildTurnIds?.has(next.turnId))
      indexSavedRow(messagesByTurn, next);
  } else if (event.type === "message_text_appended") {
    const append = event.messageTextAppend;
    const existingIndex = replayIndexes
      ? replayIndex(projection.messages, replayIndexes).get(append.id)
      : projection.messages.findIndex((message) => message.id === append.id);
    if (existingIndex === undefined || existingIndex < 0) {
      throw new LocalStateError("Local history appends text to a missing message.");
    }
    const existing = projection.messages[existingIndex]!;
    if (
      existing.turnId !== append.turnId ||
      existing.role !== "assistant" ||
      existing.text.length !== append.offset
    ) {
      throw new LocalStateError("Local history appends text to a conflicting message.");
    }
    const next = {
      ...existing,
      text: existing.text + append.text,
      eventSequence: envelope.sequence,
    };
    projection.messages[existingIndex] = next;
    const threadId = conversationHistory?.threadIdByTurn.get(next.turnId);
    if (conversationHistory && threadId)
      indexSavedThreadRow(conversationHistory.messagesByThread, threadId, next);
    if (messagesByTurn && delegatedChildTurnIds?.has(next.turnId))
      indexSavedRow(messagesByTurn, next);
  } else if (event.type === "activity_saved") {
    const next = { ...event.activity, eventSequence: envelope.sequence };
    replaceByIdDuringReplay(projection.activities, next, replayIndexes);
    const threadId = conversationHistory?.threadIdByTurn.get(next.turnId);
    if (conversationHistory && threadId)
      indexSavedThreadRow(conversationHistory.activitiesByThread, threadId, next);
    if (activitiesByTurn && delegatedChildTurnIds?.has(next.turnId))
      indexSavedRow(activitiesByTurn, next);
  } else if (event.type === "plan_saved") {
    const existingIndex = replayIndexes
      ? replayIndex(projection.plans, replayIndexes).get(event.plan.id)
      : undefined;
    const existing = replayIndexes
      ? existingIndex === undefined
        ? undefined
        : projection.plans[existingIndex]
      : projection.plans.find((plan) => plan.id === event.plan.id);
    const next = { ...event.plan, eventSequence: existing?.eventSequence ?? envelope.sequence };
    replaceByIdDuringReplay(projection.plans, next, replayIndexes);
    if (conversationHistory)
      indexSavedThreadRow(conversationHistory.plansByThread, next.threadId, next);
  } else if (event.type === "context_receipt_saved") {
    const existingIndex = replayIndexes
      ? replayIndex(projection.contextReceipts, replayIndexes).get(event.contextReceipt.id)
      : undefined;
    const existing = replayIndexes
      ? existingIndex === undefined
        ? undefined
        : projection.contextReceipts[existingIndex]
      : projection.contextReceipts.find((receipt) => receipt.id === event.contextReceipt.id);
    const contextReceipt = existing
      ? { ...event.contextReceipt, createdAt: existing.createdAt }
      : event.contextReceipt;
    replaceByIdDuringReplay(projection.contextReceipts, contextReceipt, replayIndexes);
    if (conversationHistory)
      indexSavedThreadRow(
        conversationHistory.contextReceiptsByThread,
        contextReceipt.threadId,
        contextReceipt,
      );
  } else if (event.type === "usage_receipt_saved") {
    replaceByIdDuringReplay(projection.usageReceipts, event.usageReceipt, replayIndexes);
    if (conversationHistory)
      indexSavedThreadRow(
        conversationHistory.usageReceiptsByThread,
        event.usageReceipt.threadId,
        event.usageReceipt,
      );
  } else if (event.type === "governance_correlation_saved") {
    replaceByIdDuringReplay(
      projection.governanceCorrelations,
      event.governanceCorrelation,
      replayIndexes,
    );
    if (conversationHistory)
      indexSavedThreadRow(
        conversationHistory.governanceCorrelationsByThread,
        event.governanceCorrelation.threadId,
        event.governanceCorrelation,
      );
  } else if (event.type === "provider_session_saved") {
    const index = projection.providerSessions.findIndex(
      (item) =>
        item.threadId === event.providerSession.threadId &&
        item.provider === event.providerSession.provider,
    );
    if (index === -1) projection.providerSessions.push(event.providerSession);
    else projection.providerSessions[index] = event.providerSession;
    if (conversationHistory)
      indexSavedProviderSession(
        conversationHistory.providerSessionsByThread,
        event.providerSession,
      );
  } else if (event.type === "checkpoint_saved") {
    replaceByIdDuringReplay(projection.checkpoints, event.checkpoint, replayIndexes);
    if (conversationHistory)
      indexSavedThreadRow(
        conversationHistory.checkpointsByThread,
        event.checkpoint.threadId,
        event.checkpoint,
      );
  } else if (event.type === "annotation_saved") {
    replaceByIdDuringReplay(projection.annotations, event.annotation, replayIndexes);
    conversationHistory?.annotationById.set(event.annotation.id, event.annotation);
  } else if (event.type === "file_review_saved") {
    const previous = projection.fileReviews.find((review) => review.id === event.fileReview.id);
    replaceByIdDuringReplay(projection.fileReviews, event.fileReview, replayIndexes);
    if (conversationHistory) {
      if (previous) conversationHistory.fileReviewByIdentity.delete(fileReviewIdentity(previous));
      conversationHistory.fileReviewByIdentity.set(
        fileReviewIdentity(event.fileReview),
        event.fileReview,
      );
    }
  } else if (event.type === "conversation_deletion_saved") {
    const index = projection.conversationDeletions.findIndex(
      (item) => item.threadId === event.conversationDeletion.threadId,
    );
    if (index === -1) projection.conversationDeletions.push(event.conversationDeletion);
    else projection.conversationDeletions[index] = event.conversationDeletion;
    conversationHistory?.conversationDeletionByThread.set(
      event.conversationDeletion.threadId,
      event.conversationDeletion,
    );
  } else if (event.type === "fork_created") {
    replaceByIdDuringReplay(projection.threads, event.thread, replayIndexes);
    replaceByIdDuringReplay(projection.forks, event.fork, replayIndexes);
    conversationHistory?.threadById.set(event.thread.id, event.thread);
    conversationHistory?.forkByDestinationThread.set(event.fork.destinationThreadId, event.fork);
  } else if (event.type === "fork_saved") {
    const previous = projection.forks.find((fork) => fork.id === event.fork.id);
    replaceByIdDuringReplay(projection.forks, event.fork, replayIndexes);
    if (conversationHistory) {
      if (previous && previous.destinationThreadId !== event.fork.destinationThreadId) {
        conversationHistory.forkByDestinationThread.delete(previous.destinationThreadId);
      }
      conversationHistory.forkByDestinationThread.set(event.fork.destinationThreadId, event.fork);
    }
  } else if (event.type === "delegated_relationship_saved") {
    const previous = projection.delegatedRelationships.find(
      (relationship) => relationship.id === event.delegatedRelationship.id,
    );
    replaceByIdDuringReplay(
      projection.delegatedRelationships,
      event.delegatedRelationship,
      replayIndexes,
    );
    if (conversationHistory) {
      indexSavedDelegatedRelationship(
        conversationHistory.delegatedRelationshipByChild,
        previous,
        event.delegatedRelationship,
      );
    }
    if (!deferDelegatedIndexBuild && delegatedChildTurnIds && messagesByTurn && activitiesByTurn) {
      const childTurns =
        turnsByThread?.get(event.delegatedRelationship.childThreadId) ??
        projection.turns.filter(
          (turn) => turn.threadId === event.delegatedRelationship.childThreadId,
        );
      for (const turn of childTurns) delegatedChildTurnIds.add(turn.id);
      const childTurnIds = new Set(childTurns.map((turn) => turn.id));
      for (const message of projection.messages) {
        if (childTurnIds.has(message.turnId)) indexSavedRow(messagesByTurn, message);
      }
      for (const activity of projection.activities) {
        if (childTurnIds.has(activity.turnId)) indexSavedRow(activitiesByTurn, activity);
      }
    }
  } else if (event.type === "input_request_saved") {
    replaceByIdDuringReplay(projection.inputRequests, event.inputRequest, replayIndexes);
    if (conversationHistory) {
      indexSavedThreadRow(
        conversationHistory.inputRequestsByThread,
        event.inputRequest.threadId,
        event.inputRequest,
      );
      conversationHistory.inputRequestById.set(event.inputRequest.id, event.inputRequest);
    }
  } else if (event.type === "input_receipt_saved") {
    replaceByIdDuringReplay(projection.inputReceipts, event.inputReceipt, replayIndexes);
  } else if (event.type === "mailbox_transfer_saved") {
    const previous = conversationHistory?.mailboxTransferById.get(event.mailboxTransfer.id);
    replaceByIdDuringReplay(projection.mailboxTransfers, event.mailboxTransfer, replayIndexes);
    if (conversationHistory) {
      if (previous) conversationHistory.mailboxTransferByKey.delete(previous.idempotencyKey);
      indexSavedMailboxTransfer(
        conversationHistory.mailboxTransfersByThread,
        previous,
        event.mailboxTransfer,
      );
      conversationHistory.mailboxTransferById.set(event.mailboxTransfer.id, event.mailboxTransfer);
      conversationHistory.mailboxTransferByKey.set(
        event.mailboxTransfer.idempotencyKey,
        event.mailboxTransfer,
      );
    }
  } else if (event.type === "automation_fire_saved") {
    const previous = conversationHistory?.automationFireById.get(event.automationFire.id);
    replaceByIdDuringReplay(projection.automationFires, event.automationFire, replayIndexes);
    if (conversationHistory) {
      if (previous) {
        conversationHistory.automationFireByKey.delete(automationFireIdentity(previous));
        if (previous.turnId) conversationHistory.automationFireByTurnId.delete(previous.turnId);
      }
      conversationHistory.automationFireById.set(event.automationFire.id, event.automationFire);
      conversationHistory.automationFireByKey.set(
        automationFireIdentity(event.automationFire),
        event.automationFire,
      );
      if (event.automationFire.turnId) {
        conversationHistory.automationFireByTurnId.set(
          event.automationFire.turnId,
          event.automationFire,
        );
      }
    }
  } else if (event.type === "autonomy_run_saved") {
    replaceByIdDuringReplay(projection.autonomyRuns, event.autonomyRun, replayIndexes);
  } else if (event.type === "autonomy_task_saved") {
    replaceByIdDuringReplay(projection.autonomyTasks, event.autonomyTask, replayIndexes);
  } else if (event.type === "autonomy_flow_saved") {
    replaceByIdDuringReplay(projection.autonomyFlows, event.autonomyFlow, replayIndexes);
  } else if (event.type === "heartbeat_monitor_saved") {
    replaceByIdDuringReplay(projection.heartbeatMonitors, event.heartbeatMonitor, replayIndexes);
  } else if (event.type === "standing_order_saved") {
    replaceByIdDuringReplay(projection.standingOrders, event.standingOrder, replayIndexes);
  } else if (event.type === "autonomy_hook_saved") {
    replaceByIdDuringReplay(projection.autonomyHooks, event.autonomyHook, replayIndexes);
  } else {
    throw new LocalStateError("Local history contains an unsupported event type.");
  }
  if (conversationHistory) {
    if (event.type === "mailbox_transfer_saved") {
      conversationHistory.revisionByThread.set(
        event.mailboxTransfer.sourceThreadId,
        envelope.sequence,
      );
      conversationHistory.revisionByThread.set(
        event.mailboxTransfer.destinationThreadId,
        envelope.sequence,
      );
    } else {
      const threadId = historyThreadIdForEvent(event, conversationHistory);
      if (threadId) conversationHistory.revisionByThread.set(threadId, envelope.sequence);
    }
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
    message_text_appended: "messageTextAppend",
    activity_saved: "activity",
    plan_saved: "plan",
    context_receipt_saved: "contextReceipt",
    usage_receipt_saved: "usageReceipt",
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
    mailbox_transfer_saved: "mailboxTransfer",
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
      : key === "messageTextAppend"
        ? typeof payload.id !== "string" ||
          payload.id.length === 0 ||
          typeof payload.turnId !== "string" ||
          payload.turnId.length === 0 ||
          !Number.isSafeInteger(payload.offset) ||
          Number(payload.offset) < 0 ||
          typeof payload.text !== "string" ||
          payload.text.length === 0
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
          usageReceipts: Number(records.usageReceipts ?? 0),
          governanceCorrelations: Number(records.governanceCorrelations ?? 0),
          providerSessions: Number(records.providerSessions ?? 0),
          checkpoints: Number(records.checkpoints ?? 0),
          annotations: Number(records.annotations ?? 0),
          fileReviews: Number(records.fileReviews ?? 0),
          forks: Number(records.forks ?? 0),
          delegatedRelationships: Number(records.delegatedRelationships ?? 0),
          inputRequests: Number(records.inputRequests ?? 0),
          inputReceipts: Number(records.inputReceipts ?? 0),
          mailboxTransfers: Number(records.mailboxTransfers ?? 0),
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

async function* streamEventEnvelopes(
  handle: FileHandle,
  maxBytes = MAX_EVENT_ENVELOPE_BYTES,
): AsyncGenerator<EventEnvelope> {
  const input = handle.createReadStream({ start: 0, autoClose: false });
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let lineNumber = 0;
  const emitLine = function* (raw: Buffer): Generator<EventEnvelope> {
    lineNumber += 1;
    const lineBuffer =
      raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
    if (lineBuffer.length === 0) return;
    if (lineBuffer.length > maxBytes) {
      throw new LocalStateError(
        `Local history event exceeds the supported size at line ${lineNumber}.`,
      );
    }
    yield parseEnvelope(lineBuffer.toString("utf8"), lineNumber);
  };
  const appendPending = (chunk: Buffer): void => {
    if (chunk.length === 0) return;
    pendingChunks.push(chunk);
    pendingBytes += chunk.length;
  };
  const takePending = (): Buffer => {
    const pending =
      pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks, pendingBytes);
    pendingChunks = [];
    pendingBytes = 0;
    return pending;
  };
  try {
    for await (const rawChunk of input) {
      let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      while (chunk.length > 0) {
        const newline = chunk.indexOf(0x0a);
        const segment = newline === -1 ? chunk : chunk.subarray(0, newline);
        appendPending(segment);
        if (pendingBytes > maxBytes + 1) {
          throw new LocalStateError(
            `Local history event exceeds the supported size at line ${lineNumber + 1}.`,
          );
        }
        if (newline === -1) break;
        yield* emitLine(takePending());
        chunk = chunk.subarray(newline + 1);
      }
    }
    if (pendingBytes > 0) {
      yield* emitLine(takePending());
    }
  } finally {
    input.destroy();
  }
}

function assertEventEnvelopeSize(serialized: string, lineNumber?: number): void {
  if (Buffer.byteLength(serialized, "utf8") <= MAX_EVENT_ENVELOPE_BYTES) return;
  throw new LocalStateError(
    lineNumber === undefined
      ? "Local history event exceeds the supported size."
      : `Local history event exceeds the supported size at line ${lineNumber}.`,
  );
}

function sameEventHistoryFile(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    left.size === right.size &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

interface EventHistoryWriteHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
}

export async function writeEventHistory(
  handle: EventHistoryWriteHandle,
  envelopes: Iterable<EventEnvelope>,
  maxBufferBytes = MAX_EVENT_HISTORY_WRITE_BUFFER_BYTES,
): Promise<void> {
  let buffered: string[] = [];
  let bufferedBytes = 0;
  const flush = async () => {
    if (buffered.length === 0) return;
    await handle.writeFile(buffered.join(""), "utf8");
    buffered = [];
    bufferedBytes = 0;
  };
  let index = 0;
  for (const envelope of envelopes) {
    const serialized = JSON.stringify(envelope);
    index += 1;
    assertEventEnvelopeSize(serialized, index);
    const lineBytes = Buffer.byteLength(serialized, "utf8") + 1;
    if (lineBytes > maxBufferBytes) {
      await flush();
      await handle.writeFile(serialized, "utf8");
      await handle.writeFile("\n", "utf8");
      continue;
    }
    if (bufferedBytes + lineBytes > maxBufferBytes) await flush();
    buffered.push(`${serialized}\n`);
    bufferedBytes += lineBytes;
  }
  await flush();
}

export function defaultStateDirectory(): string {
  const configured = process.env.ALDUNIS_CODE_STATE_DIR;
  if (configured) return configured;
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "aldunis-code");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readLinuxStarttime(pid: number): Promise<string | null> {
  try {
    const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = processStat.lastIndexOf(")");
    if (closeParen < 0) return null;
    return processStat.slice(closeParen + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function parseWriterLeaseIdentity(raw: string): WriterLeaseIdentity | null {
  if (raw.length > MAX_WRITER_LEASE_IDENTITY_BYTES) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WriterLeaseIdentity>;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.hostname !== "string" || parsed.hostname.length === 0) return null;
    if (typeof parsed.createdAt !== "string" || parsed.createdAt.length === 0) return null;
    return {
      pid: parsed.pid,
      hostname: parsed.hostname,
      createdAt: parsed.createdAt,
      starttime: typeof parsed.starttime === "string" ? parsed.starttime : null,
    };
  } catch {
    return null;
  }
}

async function readWriterLeaseIdentityFrom(path: string): Promise<WriterLeaseIdentity | null> {
  try {
    return parseWriterLeaseIdentity(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function statWriterLock(directory: string) {
  try {
    return await stat(join(directory, HOST_WRITER_LOCK));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readWriterLeaseIdentity(
  directory: string,
  lockStat: Awaited<ReturnType<typeof stat>>,
): Promise<WriterLeaseIdentity | null> {
  const lockPath = join(directory, HOST_WRITER_LOCK);
  if (lockStat.isFile()) return readWriterLeaseIdentityFrom(lockPath);
  if (lockStat.isDirectory()) {
    return readWriterLeaseIdentityFrom(join(lockPath, HOST_WRITER_LEASE_IDENTITY));
  }
  return null;
}

async function writerLeaseHolderState(
  identity: WriterLeaseIdentity,
): Promise<"alive" | "dead" | "unknown"> {
  if (identity.hostname !== hostname()) return "unknown";
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  if (identity.starttime) {
    const current = await readLinuxStarttime(identity.pid);
    if (current && current !== identity.starttime) return "dead";
  }
  return "alive";
}

async function reclaimOrphanedWriterLock(directory: string): Promise<boolean> {
  const lockPath = join(directory, HOST_WRITER_LOCK);
  let lockStat = await statWriterLock(directory);
  if (!lockStat) return false;
  let identity = await readWriterLeaseIdentity(directory, lockStat);
  if (!identity) {
    await delay(WRITER_LEASE_IDENTITY_GRACE_MS);
    lockStat = await statWriterLock(directory);
    if (!lockStat) return false;
    identity = await readWriterLeaseIdentity(directory, lockStat);
  }
  const holder = identity ? await writerLeaseHolderState(identity) : null;
  const stale = Date.now() - lockStat.mtimeMs >= WRITER_LEASE_STALE_MS;
  if (holder === "alive" && identity?.starttime) return false;
  if (holder !== "dead" && !stale) return false;
  const quarantine = join(directory, `${HOST_WRITER_LOCK}.reclaim-${randomUUID()}`);
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const quarantined = await stat(quarantine);
    if (quarantined.dev !== lockStat.dev || quarantined.ino !== lockStat.ino) {
      try {
        await rename(quarantine, lockPath);
      } catch {
        throw new LocalStateError(
          "The local-state writer lock changed while it was being reclaimed.",
        );
      }
      return false;
    }
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error instanceof LocalStateError) throw error;
    await rename(quarantine, lockPath).catch(() => undefined);
    throw error;
  }
}

export class LocalStateStore {
  readonly #eventPath: string;
  readonly #options: LocalStateStoreOptions;
  #projection = emptyProjection();
  #turnsByThread = new Map<string, Turn[]>();
  #messagesByTurn = new Map<string, Map<string, Message>>();
  #activitiesByTurn = new Map<string, Map<string, Activity>>();
  #delegatedChildTurnIds = new Set<string>();
  #conversationHistory = buildConversationHistoryIndex(this.#projection, this.#turnsByThread);
  #writeQueue: Promise<void> = Promise.resolve();
  #writeFailure: unknown | null = null;
  #loaded = false;
  #loadPromise: Promise<void> | null = null;
  /**
   * Open assistant segments that have been applied to the in-memory projection
   * and may still be growing. Closed on tool/approval/input or terminal turn
   * events so stream tokens do not each become a durable row.
   */
  readonly #openAssistantByTurn = new Map<string, Message>();
  /** Last live chunk ended in whitespace; avoids flattening the growing text rope. */
  readonly #openAssistantEndsWithWhitespace = new Map<string, boolean>();
  /** Characters already journaled for each open segment (soft checkpoints). */
  readonly #openAssistantDurableLength = new Map<string, number>();
  /** Soft-checkpoint growth threshold so long text-only replies are not only in RAM. */
  static readonly ASSISTANT_CHECKPOINT_CHARS = 4_096;

  constructor(
    readonly directory = defaultStateDirectory(),
    options: LocalStateStoreOptions = {},
  ) {
    this.#eventPath = join(directory, "events.v1.jsonl");
    this.#options = options;
  }

  #enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    this.#options.onWriteEnqueued?.();
    const operation = this.#writeQueue.then(async () => {
      if (this.#options.holdWrite) await this.#options.holdWrite();
      return action();
    });
    this.#writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #readProjection(): Promise<{
    envelopes: EventEnvelope[];
    projection: StateProjection;
    turnsByThread: Map<string, Turn[]>;
    messagesByTurn: Map<string, Map<string, Message>>;
    activitiesByTurn: Map<string, Map<string, Activity>>;
    delegatedChildTurnIds: Set<string>;
    conversationHistory: MutableConversationHistoryIndex;
    repaired: boolean;
    sourceIdentity: Awaited<ReturnType<FileHandle["stat"]>> | null;
  }> {
    let handle: FileHandle;
    try {
      handle = await open(this.#eventPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const projection = emptyProjection();
        const turnsByThread = new Map<string, Turn[]>();
        return {
          envelopes: [],
          projection,
          turnsByThread,
          messagesByTurn: new Map(),
          activitiesByTurn: new Map(),
          delegatedChildTurnIds: new Set(),
          conversationHistory: buildConversationHistoryIndex(projection, turnsByThread),
          repaired: false,
          sourceIdentity: null,
        };
      }
      throw new LocalStateError("Local history could not be read.");
    }
    try {
      if (this.#options.holdHistoryRead) await this.#options.holdHistoryRead();
      const sourceIdentity = await handle.stat();
      let projection = emptyProjection();
      let parsedCount = 0;
      let maximumSequence = 0;
      let firstMismatch: { actual: number; expected: number } | null = null;
      let forkSequences: Set<number> | null = null;
      const replayIndexes: ReplayIndexes = new Map();
      const turnsByThread = new Map<string, Turn[]>();
      const messagesByTurn = new Map<string, Map<string, Message>>();
      const activitiesByTurn = new Map<string, Map<string, Activity>>();
      const delegatedChildTurnIds = new Set<string>();
      for await (const envelope of streamEventEnvelopes(handle)) {
        parsedCount += 1;
        maximumSequence = Math.max(maximumSequence, envelope.sequence);
        if (!firstMismatch && envelope.sequence !== parsedCount) {
          firstMismatch = { actual: envelope.sequence, expected: parsedCount };
          forkSequences = new Set<number>();
          for (let sequence = 1; sequence < parsedCount; sequence += 1) {
            forkSequences.add(sequence);
          }
        }
        if (forkSequences) forkSequences.add(envelope.sequence);
        if (!firstMismatch)
          applyEvent(
            projection,
            envelope,
            replayIndexes,
            turnsByThread,
            messagesByTurn,
            activitiesByTurn,
            delegatedChildTurnIds,
            true,
          );
      }
      if (!firstMismatch) {
        rebuildDelegatedTranscriptIndexes(
          projection,
          messagesByTurn,
          activitiesByTurn,
          delegatedChildTurnIds,
        );
        return {
          envelopes: [],
          projection,
          turnsByThread,
          messagesByTurn,
          activitiesByTurn,
          delegatedChildTurnIds,
          conversationHistory: buildConversationHistoryIndex(projection, turnsByThread),
          repaired: false,
          sourceIdentity,
        };
      }
      const isCompleteFork =
        Number.isSafeInteger(maximumSequence) &&
        maximumSequence > 0 &&
        parsedCount > maximumSequence &&
        forkSequences !== null &&
        forkSequences.size === maximumSequence &&
        [...forkSequences].every(
          (sequence) =>
            Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= maximumSequence,
        );
      if (!isCompleteFork) {
        throw new LocalStateError(
          `Local history is not ordered at event ${firstMismatch.actual}; expected ${firstMismatch.expected}.`,
        );
      }
      projection = emptyProjection();
      const envelopes: EventEnvelope[] = [];
      const repairIndexes: ReplayIndexes = new Map();
      const repairTurnsByThread = new Map<string, Turn[]>();
      const repairMessagesByTurn = new Map<string, Map<string, Message>>();
      const repairActivitiesByTurn = new Map<string, Map<string, Activity>>();
      const repairDelegatedChildTurnIds = new Set<string>();
      const repairHandle = await open(this.#eventPath, "r");
      try {
        const repairIdentity = await repairHandle.stat();
        if (
          !sameEventHistoryFile(sourceIdentity, repairIdentity) ||
          !sameEventHistoryFile(repairIdentity, await stat(this.#eventPath))
        ) {
          throw new LocalStateError("Local history changed while it was being repaired.");
        }
        for await (const parsed of streamEventEnvelopes(repairHandle)) {
          const envelope = { ...parsed, sequence: envelopes.length + 1 };
          envelopes.push(envelope);
          applyEvent(
            projection,
            envelope,
            repairIndexes,
            repairTurnsByThread,
            repairMessagesByTurn,
            repairActivitiesByTurn,
            repairDelegatedChildTurnIds,
            true,
          );
        }
        if (!sameEventHistoryFile(sourceIdentity, await stat(this.#eventPath))) {
          throw new LocalStateError("Local history changed while it was being repaired.");
        }
      } finally {
        await repairHandle.close().catch(() => undefined);
      }
      rebuildDelegatedTranscriptIndexes(
        projection,
        repairMessagesByTurn,
        repairActivitiesByTurn,
        repairDelegatedChildTurnIds,
      );
      return {
        envelopes,
        projection,
        turnsByThread: repairTurnsByThread,
        messagesByTurn: repairMessagesByTurn,
        activitiesByTurn: repairActivitiesByTurn,
        delegatedChildTurnIds: repairDelegatedChildTurnIds,
        conversationHistory: buildConversationHistoryIndex(projection, repairTurnsByThread),
        repaired: true,
        sourceIdentity,
      };
    } catch (error) {
      if (error instanceof LocalStateError) throw error;
      throw new LocalStateError("Local history could not be read.");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #replaceHistory(envelopes: Iterable<EventEnvelope>): Promise<void> {
    const temporary = join(this.directory, `.events-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await writeEventHistory(handle, envelopes);
        await handle.sync();
      } finally {
        await handle.close();
      }
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
    await writeFile(join(this.directory, HOST_WRITER_TARGET), "", { mode: 0o600 }).catch(
      () => undefined,
    );
    return this.#lockWriter({ allowReclaim: true });
  }

  async #lockWriter(options: { allowReclaim: boolean }): Promise<() => Promise<void>> {
    const lockPath = join(this.directory, HOST_WRITER_LOCK);
    const openExclusive = () => open(lockPath, "wx", 0o600);
    let handle: FileHandle;
    try {
      handle = await openExclusive();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EISDIR") throw error;
      if (!options.allowReclaim || !(await reclaimOrphanedWriterLock(this.directory))) {
        throw new LocalStateError(
          "Another Aldunis Code host is already using this local state directory.",
          503,
        );
      }
      try {
        handle = await openExclusive();
      } catch (retryError) {
        const retryCode = (retryError as NodeJS.ErrnoException).code;
        if (retryCode === "EEXIST" || retryCode === "EISDIR") {
          throw new LocalStateError(
            "Another Aldunis Code host is already using this local state directory.",
            503,
          );
        }
        throw retryError;
      }
    }
    try {
      const identity: WriterLeaseIdentity = {
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
        starttime: await readLinuxStarttime(process.pid),
      };
      await handle.writeFile(`${JSON.stringify(identity)}\n`);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const acquired = await handle.stat();
    const heartbeat = setInterval(() => {
      const now = new Date();
      void handle.utimes(now, now).catch(() => undefined);
    }, WRITER_LEASE_UPDATE_MS);
    heartbeat.unref();
    return async () => {
      clearInterval(heartbeat);
      try {
        const current = await statWriterLock(this.directory);
        if (!current || current.dev !== acquired.dev || current.ino !== acquired.ino) return;
        const quarantine = join(this.directory, `${HOST_WRITER_LOCK}.release-${randomUUID()}`);
        try {
          await rename(lockPath, quarantine);
        } catch {
          return;
        }
        const quarantined = await stat(quarantine).catch(() => null);
        if (!quarantined || quarantined.dev !== acquired.dev || quarantined.ino !== acquired.ino) {
          await rename(quarantine, lockPath).catch(() => undefined);
          return;
        }
        await rm(quarantine, { force: true });
      } finally {
        await handle.close().catch(() => undefined);
      }
    };
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    if (!this.#loadPromise) {
      this.#loadPromise = this.#initializeProjection();
    }
    try {
      await this.#loadPromise;
    } catch (error) {
      this.#loadPromise = null;
      throw error;
    }
  }

  async #initializeProjection(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const history = await this.#readProjection();
    if (history.repaired) {
      if (!history.sourceIdentity) {
        throw new LocalStateError("Local history could not be repaired.");
      }
      let currentIdentity: Awaited<ReturnType<typeof stat>>;
      try {
        currentIdentity = await stat(this.#eventPath);
      } catch {
        throw new LocalStateError("Local history changed while it was being repaired.");
      }
      if (!sameEventHistoryFile(history.sourceIdentity, currentIdentity)) {
        throw new LocalStateError("Local history changed while it was being repaired.");
      }
      await this.#replaceHistory(history.envelopes);
    }
    this.#projection = history.projection;
    this.#turnsByThread = history.turnsByThread;
    this.#messagesByTurn = history.messagesByTurn;
    this.#activitiesByTurn = history.activitiesByTurn;
    this.#delegatedChildTurnIds = history.delegatedChildTurnIds;
    this.#conversationHistory = history.conversationHistory;
    this.#loaded = true;
  }

  async load(): Promise<StateProjection> {
    await this.#ensureLoaded();
    return structuredClone(this.#projection);
  }

  /** Clone only the bounded Autonomy ledger, excluding conversation history. */
  async loadAutonomyProjection(): Promise<
    Pick<
      StateProjection,
      | "autonomyRuns"
      | "autonomyTasks"
      | "autonomyFlows"
      | "heartbeatMonitors"
      | "standingOrders"
      | "autonomyHooks"
    >
  > {
    return structuredClone(await this.inspectAutonomyProjection());
  }

  /**
   * Live Autonomy ledger after the current write generation.
   * Callers must not mutate the returned collections or records.
   */
  async inspectAutonomyProjection(): Promise<
    Readonly<
      Pick<
        StateProjection,
        | "autonomyRuns"
        | "autonomyTasks"
        | "autonomyFlows"
        | "heartbeatMonitors"
        | "standingOrders"
        | "autonomyHooks"
      >
    >
  > {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const projection = this.#projection;
    return {
      autonomyRuns: projection.autonomyRuns,
      autonomyTasks: projection.autonomyTasks,
      autonomyFlows: projection.autonomyFlows,
      heartbeatMonitors: projection.heartbeatMonitors,
      standingOrders: projection.standingOrders,
      autonomyHooks: projection.autonomyHooks,
    };
  }

  /** Clone only the state required to admit a new Autonomy run. */
  async loadAutonomyRunAdmissionProjection(): Promise<
    Pick<StateProjection, "projects" | "autonomyFlows">
  > {
    await this.#ensureLoaded();
    await this.#writeQueue;
    return structuredClone({
      projects: this.#projection.projects,
      autonomyFlows: this.#projection.autonomyFlows,
    });
  }

  /** Clone one queued Autonomy run without cloning unrelated retained state. */
  async loadAutonomyRun(runId: string): Promise<AutonomyRun | null> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const run = this.#projection.autonomyRuns.find((candidate) => candidate.id === runId);
    return run ? structuredClone(run) : null;
  }

  /**
   * Read-only live projection for request handlers that project a subset.
   * Callers must not mutate the returned object.
   */
  async inspect(): Promise<Readonly<StateProjection>> {
    await this.#ensureLoaded();
    return this.#projection;
  }

  /** Read one thread status from the same live projection/index generation. */
  async inspectThreadStatus(threadId: string): Promise<ThreadStatusProjection> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    return projectThreadStatusFromTurns(
      this.#conversationHistory.threadById.get(threadId),
      this.#turnsByThread.get(threadId) ?? [],
      threadId,
    );
  }

  /** Read automation admission state from the live per-thread turn index. */
  async inspectThreadBusy(threadId: string): Promise<boolean> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    return (this.#turnsByThread.get(threadId) ?? []).some((turn) =>
      BUSY_TURN_STATUSES.has(turn.status),
    );
  }

  /** Resolve one provider run without scanning retained conversation history. */
  async inspectProviderRunConversation(
    providerRunId: string,
  ): Promise<{ turn: Readonly<Turn>; thread: Readonly<Thread> } | null> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const turn = this.#conversationHistory.turnByProviderRunId.get(providerRunId);
    if (!turn) return null;
    const thread = this.#conversationHistory.threadById.get(turn.threadId);
    return thread ? { turn, thread } : null;
  }

  /** Read provider-event context from one coherent thread-local index generation. */
  async #inspectProviderEventContext(
    threadId: string,
    turnId?: string,
  ): Promise<ProviderEventContext> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const history = this.#conversationHistory;
    return {
      thread: history.threadById.get(threadId),
      turn: turnId
        ? (this.#turnsByThread.get(threadId) ?? []).find((item) => item.id === turnId)
        : undefined,
      inputRequests: history.inputRequestsByThread.get(threadId) ?? [],
      plans: history.plansByThread.get(threadId) ?? [],
      usageReceipts: history.usageReceiptsByThread.get(threadId) ?? [],
      governanceCorrelations: history.governanceCorrelationsByThread.get(threadId) ?? [],
      providerSessions: history.providerSessionsByThread.get(threadId) ?? [],
    };
  }

  /** Capture the live projection and its derived indexes from one write generation. */
  async inspectWorkbenchProjection(): Promise<WorkbenchProjectionIndexes> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    return {
      projection: this.#projection,
      turnsByThread: this.#turnsByThread,
      delegatedMessagesByTurn: this.#messagesByTurn,
      delegatedActivitiesByTurn: this.#activitiesByTurn,
      conversationHistory: this.#conversationHistory,
    };
  }

  /**
   * Live turns grouped by conversation, maintained as events apply.
   * Callers must not mutate the returned map or its arrays.
   */
  async turnsByThreadIndex(): Promise<TurnsByThreadIndex> {
    await this.#ensureLoaded();
    return this.#turnsByThread;
  }

  /** Transcript rows retained only for turns belonging to delegated children. */
  async delegatedMessagesByTurnIndex(): Promise<DelegatedMessagesByTurnIndex> {
    await this.#ensureLoaded();
    return this.#messagesByTurn;
  }

  /** Activity rows retained only for turns belonging to delegated children. */
  async delegatedActivitiesByTurnIndex(): Promise<DelegatedActivitiesByTurnIndex> {
    await this.#ensureLoaded();
    return this.#activitiesByTurn;
  }

  async #append(event: StateEvent): Promise<void> {
    await this.#appendComputed(() => ({ event, value: undefined }));
  }

  async #appendComputed<T>(
    compute: (projection: StateProjection) => { event: StateEvent | StateEvent[] | null; value: T },
  ): Promise<T> {
    // Internal mutators only need the live projection; avoid cloning multi-MB
    // history on every append path.
    await this.#ensureLoaded();
    let result!: T;
    const operation = this.#enqueueWrite(async () => {
      if (this.#writeFailure) throw this.#writeFailure;
      const computed = compute(this.#projection);
      result = computed.value;
      if (!computed.event) return;
      const events = Array.isArray(computed.event) ? computed.event : [computed.event];
      if (events.length === 0) return;
      const pending = events.map((event, index) => {
        const envelope: EventEnvelope = {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          sequence: this.#projection.sequence + index + 1,
          id: randomUUID(),
          recordedAt: new Date().toISOString(),
          event,
        };
        const serialized = JSON.stringify(envelope);
        assertEventEnvelopeSize(serialized);
        return { envelope, serialized };
      });
      let handle: FileHandle | null = null;
      let writeMayHaveBegun = false;
      try {
        handle = await open(this.#eventPath, "a", 0o600);
        for (const { serialized } of pending) {
          writeMayHaveBegun = true;
          await handle.writeFile(`${serialized}\n`, "utf8");
        }
        await handle.sync();
        await handle.close();
        handle = null;
        for (const { envelope } of pending) {
          applyEvent(
            this.#projection,
            envelope,
            undefined,
            this.#turnsByThread,
            this.#messagesByTurn,
            this.#activitiesByTurn,
            this.#delegatedChildTurnIds,
            false,
            this.#conversationHistory,
          );
        }
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (writeMayHaveBegun) this.#writeFailure ??= error;
        throw error;
      }
    });
    await operation;
    return result;
  }

  async #writeMessageEnvelope(message: Message, durableLength = 0): Promise<void> {
    const appendedText = durableLength > 0 ? message.text.slice(durableLength) : null;
    if (appendedText !== null && !appendedText) return;
    const envelope: EventEnvelope = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      sequence: this.#projection.sequence + 1,
      id: randomUUID(),
      recordedAt: new Date().toISOString(),
      event:
        appendedText === null
          ? { type: "message_saved", message: { ...message } }
          : {
              type: "message_text_appended",
              messageTextAppend: {
                schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
                id: message.id,
                turnId: message.turnId,
                offset: durableLength,
                text: appendedText,
              },
            },
    };
    const serialized = JSON.stringify(envelope);
    assertEventEnvelopeSize(serialized);
    let handle: FileHandle | null = null;
    let writeMayHaveBegun = false;
    try {
      handle = await open(this.#eventPath, "a", 0o600);
      writeMayHaveBegun = true;
      await handle.writeFile(`${serialized}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (this.#openAssistantByTurn.get(message.turnId) === message) {
        // The live segment is already the inspect-visible record. Persist
        // without replaceById so later tokens keep mutating that same object.
        if (envelope.sequence !== this.#projection.sequence + 1) {
          throw new LocalStateError(
            `Local history is not ordered at event ${envelope.sequence}; expected ${this.#projection.sequence + 1}.`,
          );
        }
        message.eventSequence = envelope.sequence;
        this.#projection.sequence = envelope.sequence;
        const threadId = this.#conversationHistory.threadIdByTurn.get(message.turnId);
        if (threadId) {
          this.#conversationHistory.revisionByThread.set(threadId, envelope.sequence);
        }
        return;
      }
      applyEvent(
        this.#projection,
        envelope,
        undefined,
        this.#turnsByThread,
        this.#messagesByTurn,
        this.#activitiesByTurn,
        this.#delegatedChildTurnIds,
        false,
        this.#conversationHistory,
      );
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (writeMayHaveBegun) this.#writeFailure ??= error;
      throw error;
    }
  }

  #publishOpenAssistant(segment: Message): void {
    this.#projection.messages.push(segment);
    const threadId = this.#conversationHistory.threadIdByTurn.get(segment.turnId);
    if (threadId) {
      const bucket = this.#conversationHistory.messagesByThread.get(threadId);
      if (bucket) bucket.push(segment);
      else this.#conversationHistory.messagesByThread.set(threadId, [segment]);
    }
    if (this.#delegatedChildTurnIds.has(segment.turnId)) {
      indexSavedRow(this.#messagesByTurn, segment);
    }
  }

  #appendOpenAssistantText(turnId: string, text: string): Message {
    let segment = this.#openAssistantByTurn.get(turnId);
    if (!segment) {
      segment = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        turnId,
        role: "assistant",
        text: "",
        createdAt: new Date().toISOString(),
      };
      this.#openAssistantByTurn.set(turnId, segment);
      this.#openAssistantEndsWithWhitespace.set(turnId, false);
      this.#openAssistantDurableLength.set(turnId, 0);
      this.#publishOpenAssistant(segment);
    }
    segment.text = appendAssistantTextChunkWithWhitespaceState(
      segment.text,
      text,
      this.#openAssistantEndsWithWhitespace.get(turnId) ?? false,
    );
    this.#openAssistantEndsWithWhitespace.set(turnId, /\s/.test(text.at(-1)!));
    return segment;
  }

  async #checkpointOpenAssistant(turnId: string, segment: Message): Promise<void> {
    if (this.#writeFailure) throw this.#writeFailure;
    if (this.#openAssistantByTurn.get(turnId) !== segment) return;
    if (
      segment.text.length - (this.#openAssistantDurableLength.get(turnId) ?? 0) <
      LocalStateStore.ASSISTANT_CHECKPOINT_CHARS
    ) {
      return;
    }
    await this.#writeMessageEnvelope(segment, this.#openAssistantDurableLength.get(turnId) ?? 0);
    this.#openAssistantDurableLength.set(turnId, segment.text.length);
  }

  async #bufferAssistantText(turnId: string, text: string): Promise<void> {
    if (!text) return;
    await this.#ensureLoaded();
    if (this.#writeFailure) throw this.#writeFailure;
    // Always mutate the live open segment so inspect sees tokens during an
    // in-flight journal fsync. Only the 4 KiB soft-checkpoint is a write-queue
    // job; enqueue-per-token created a promise/lock convoy behind handle.sync().
    const segment = this.#appendOpenAssistantText(turnId, text);
    if (
      segment.text.length - (this.#openAssistantDurableLength.get(turnId) ?? 0) <
      LocalStateStore.ASSISTANT_CHECKPOINT_CHARS
    ) {
      return;
    }
    await this.#enqueueWrite(() => this.#checkpointOpenAssistant(turnId, segment));
  }

  async #flushOpenAssistant(turnId: string): Promise<void> {
    await this.#ensureLoaded();
    const operation = this.#enqueueWrite(async () => {
      if (this.#writeFailure) throw this.#writeFailure;
      const segment = this.#openAssistantByTurn.get(turnId);
      if (!segment) return;
      if (!segment.text) {
        this.#openAssistantByTurn.delete(turnId);
        this.#openAssistantEndsWithWhitespace.delete(turnId);
        this.#openAssistantDurableLength.delete(turnId);
        this.#projection.messages = this.#projection.messages.filter(
          (message) => message.id !== segment.id,
        );
        const threadId = this.#conversationHistory.threadIdByTurn.get(turnId);
        if (threadId)
          removeIndexedThreadRow(this.#conversationHistory.messagesByThread, threadId, segment.id);
        return;
      }
      const durableLength = this.#openAssistantDurableLength.get(turnId) ?? 0;
      if (segment.text.length === durableLength) {
        // Already journaled at this length (soft checkpoint); just close.
        this.#openAssistantByTurn.delete(turnId);
        this.#openAssistantEndsWithWhitespace.delete(turnId);
        this.#openAssistantDurableLength.delete(turnId);
        return;
      }
      // Keep the map entry until the write succeeds so a failed fsync can retry.
      await this.#writeMessageEnvelope(segment, durableLength);
      this.#openAssistantByTurn.delete(turnId);
      this.#openAssistantEndsWithWhitespace.delete(turnId);
      this.#openAssistantDurableLength.delete(turnId);
    });
    await operation;
  }

  async #flushAllOpenAssistants(): Promise<void> {
    for (const turnId of [...this.#openAssistantByTurn.keys()]) {
      await this.#flushOpenAssistant(turnId);
    }
  }

  /** Flush open stream segments before host shutdown or intentional teardown. */
  async flushPendingAssistantHistory(): Promise<void> {
    await this.#flushAllOpenAssistants();
  }

  /**
   * Rewrite local history when older stream-token rows dominate the message
   * table. No-op when already compact. Safe to call during host recovery.
   */
  async compactAssistantStreamHistory(): Promise<{ before: number; after: number } | null> {
    await this.#flushAllOpenAssistants();
    await this.#ensureLoaded();
    const before = this.#projection.messages.length;
    const after = coalescedAssistantMessageCount(
      this.#projection.messages,
      this.#projection.activities,
    );
    if (after >= before) return null;
    await this.#compact((projection) => {
      projection.messages = coalesceConsecutiveAssistantMessages(
        projection.messages,
        projection.activities,
      );
    });
    return { before, after };
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
    return this.#appendComputed(() => {
      const turn = (this.#turnsByThread.get(receipt.threadId) ?? []).find(
        (item) => item.id === receipt.turnId,
      );
      if (!turn) throw new LocalStateError("The context receipt turn is unavailable.", 404);
      const id = createHash("sha256")
        .update(`${receipt.threadId}\n${receipt.turnId}\n${receipt.digest}`, "utf8")
        .digest("hex");
      const existing = (
        this.#conversationHistory.contextReceiptsByThread.get(receipt.threadId) ?? []
      ).find((item) => item.id === id);
      const saved: ContextReceipt = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id,
        ...receipt,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      return { event: { type: "context_receipt_saved", contextReceipt: saved }, value: saved };
    });
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
    await this.#ensureLoaded();
    await this.#writeQueue;
    const projection = this.#projection;
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
    const preview = buildForkPreview(source, projection);
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
    await this.#ensureLoaded();
    await this.#writeQueue;
    const projection = this.#projection;
    const source = projection.threads.find((thread) => thread.id === sourceThreadId);
    if (!source) throw new LocalStateError("The source conversation is unavailable.", 404);
    return buildForkPreview(source, projection);
  }

  async pendingForkPrompt(threadId: string): Promise<string | null> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const fork = this.#conversationHistory.forkByDestinationThread.get(threadId);
    return fork?.status === "pending" ? fork.prompt : null;
  }

  async markForkStarted(threadId: string): Promise<void> {
    await this.#appendComputed(() => {
      const fork = this.#conversationHistory.forkByDestinationThread.get(threadId);
      return {
        event:
          fork?.status === "pending"
            ? {
                type: "fork_saved" as const,
                fork: { ...fork, status: "started" as const, startedAt: new Date().toISOString() },
              }
            : null,
        value: undefined,
      };
    });
  }

  async bindProviderRun(turnId: string, providerRunId: string): Promise<void> {
    await this.#appendComputed(() => {
      const threadId = this.#conversationHistory.threadIdByTurn.get(turnId);
      const turn = threadId
        ? this.#turnsByThread.get(threadId)?.find((item) => item.id === turnId)
        : undefined;
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.", 404);
      const fire = this.#conversationHistory.automationFireByTurnId.get(turnId);
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
    await this.#ensureLoaded();
    await this.#writeQueue;
    const fire = this.#conversationHistory.automationFireByKey.get(
      automationFireIdentity({ automationId, key }),
    );
    return fire ? structuredClone(fire) : null;
  }

  async getAutomationFireById(fireId: string): Promise<AutomationFire | null> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const fire = this.#conversationHistory.automationFireById.get(fireId);
    return fire ? structuredClone(fire) : null;
  }

  async latestAutomationFire(automationId: string): Promise<AutomationFire | null> {
    return (await this.latestAutomationFires([automationId])).get(automationId) ?? null;
  }

  async latestAutomationFires(
    automationIds: Iterable<string>,
  ): Promise<Map<string, AutomationFire>> {
    const wanted = new Set(automationIds);
    const latest = new Map<string, Readonly<AutomationFire>>();
    if (wanted.size === 0) return new Map();
    const projection = await this.inspect();
    for (const fire of projection.automationFires) {
      if (!wanted.has(fire.automationId)) continue;
      const current = latest.get(fire.automationId);
      if (!current || fire.createdAt > current.createdAt) latest.set(fire.automationId, fire);
    }
    return new Map(
      [...latest].map(([automationId, fire]) => [automationId, structuredClone(fire)]),
    );
  }

  async recordAutomationFireSkippedBusy(input: AutomationFireKey): Promise<AutomationFire> {
    return this.#appendComputed(() => {
      const existing = this.#conversationHistory.automationFireByKey.get(
        automationFireIdentity(input),
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
    return this.#appendComputed(() => {
      const existing = this.#conversationHistory.automationFireByKey.get(
        automationFireIdentity(input),
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

  async saveMailboxTransfer(input: {
    sourceThreadId: string;
    destinationThreadId: string;
    text: string;
    mode: InteractionMode;
    idempotencyKey: string;
  }): Promise<{ transfer: MailboxTransfer; created: boolean }> {
    const trimmed = input.text.trim();
    if (!trimmed || Array.from(trimmed).length > 4_000) {
      throw new LocalStateError(
        "A mailbox message between 1 and 4,000 characters is required.",
        400,
      );
    }
    if (!/^[0-9a-f-]{36}$/i.test(input.idempotencyKey)) {
      throw new LocalStateError("A mailbox idempotency key is required.", 400);
    }
    if (input.sourceThreadId === input.destinationThreadId) {
      throw new LocalStateError("A conversation cannot send a mailbox message to itself.", 400);
    }
    if (!["ask", "plan", "build"].includes(input.mode)) {
      throw new LocalStateError("A valid interaction mode is required.", 400);
    }
    return this.#appendComputed((projection) => {
      const existing = this.#conversationHistory.mailboxTransferByKey.get(input.idempotencyKey);
      if (existing) {
        if (
          existing.sourceThreadId !== input.sourceThreadId ||
          existing.destinationThreadId !== input.destinationThreadId ||
          existing.text !== trimmed ||
          existing.mode !== input.mode
        ) {
          throw new LocalStateError("This mailbox idempotency key is already bound.", 409);
        }
        const existingTurn = existing.destinationTurnId
          ? (this.#turnsByThread.get(existing.destinationThreadId) ?? []).find(
              (item) => item.id === existing.destinationTurnId,
            )
          : undefined;
        if (existingTurn?.providerRunId || existingTurn?.status === "active") {
          return { event: null, value: { transfer: existing, created: false } };
        }
        if (existingTurn) {
          return {
            event: {
              type: "turn_saved",
              turn: { ...existingTurn, status: "active", completedAt: null },
            },
            value: { transfer: existing, created: true },
          };
        }
        return { event: null, value: { transfer: existing, created: false } };
      }
      const source = this.#requireThread(projection, input.sourceThreadId);
      const destination = this.#requireThread(projection, input.destinationThreadId);
      if (source.projectId !== destination.projectId) {
        throw new LocalStateError(
          "Mailbox messages can only be sent to another conversation in the same project.",
          409,
        );
      }
      if (
        this.#conversationHistory.forkByDestinationThread.get(destination.id)?.status === "pending"
      ) {
        throw new LocalStateError(
          "Mailbox messages cannot be sent to a conversation that is still waiting to start as a fork.",
          409,
        );
      }
      if (
        (this.#turnsByThread.get(destination.id) ?? []).some((turn) =>
          BUSY_TURN_STATUSES.has(turn.status),
        )
      ) {
        throw new LocalStateError(
          "The destination conversation is busy. Wait for it to finish, then retry.",
          409,
        );
      }
      const now = new Date().toISOString();
      const turn: Turn = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        threadId: destination.id,
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
        text: trimmed,
        createdAt: now,
      };
      const transfer: MailboxTransfer = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: randomUUID(),
        sourceThreadId: source.id,
        destinationThreadId: destination.id,
        text: trimmed,
        mode: input.mode,
        createdAt: now,
        destinationTurnId: turn.id,
        idempotencyKey: input.idempotencyKey,
      };
      return {
        event: [
          { type: "thread_saved", thread: { ...destination, updatedAt: now } },
          { type: "turn_saved", turn },
          { type: "message_saved", message },
          { type: "mailbox_transfer_saved", mailboxTransfer: transfer },
        ],
        value: { transfer, created: true },
      };
    });
  }

  async mailboxTransfer(transferId: string): Promise<MailboxTransfer> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const transfer = this.#conversationHistory.mailboxTransferById.get(transferId);
    if (!transfer) throw new LocalStateError("The mailbox transfer is not available.", 404);
    return transfer;
  }

  async abandonMailboxDelivery(input: {
    transferId: string;
    destinationThreadId?: string;
    destinationTurnId?: string | null;
  }): Promise<void> {
    await this.#appendComputed(() => {
      const transfer = this.#conversationHistory.mailboxTransferById.get(input.transferId);
      const destinationThreadId = input.destinationThreadId ?? transfer?.destinationThreadId;
      const destinationTurnId = input.destinationTurnId ?? transfer?.destinationTurnId;
      if (!destinationThreadId || !destinationTurnId) return { event: null, value: undefined };
      const turn = (this.#turnsByThread.get(destinationThreadId) ?? []).find(
        (item) => item.id === destinationTurnId,
      );
      if (!turn || turn.providerRunId || turn.status !== "active") {
        return { event: null, value: undefined };
      }
      const now = new Date().toISOString();
      return {
        event: {
          type: "turn_saved",
          turn: { ...turn, status: "interrupted" as const, completedAt: now },
        },
        value: undefined,
      };
    });
  }

  async mailboxDestination(transferId: string): Promise<{
    transfer: MailboxTransfer;
    thread: Thread;
    turn: Turn;
  }> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const transfer = this.#conversationHistory.mailboxTransferById.get(transferId);
    if (!transfer?.destinationTurnId) {
      throw new LocalStateError("The mailbox transfer is not available.", 404);
    }
    const thread = this.#conversationHistory.threadById.get(transfer.destinationThreadId);
    const turn = (this.#turnsByThread.get(transfer.destinationThreadId) ?? []).find(
      (item) => item.id === transfer.destinationTurnId,
    );
    if (!thread || !turn) {
      throw new LocalStateError("The mailbox destination turn is not available.", 404);
    }
    return { transfer, thread, turn };
  }

  async bindMailboxTransferTurn(transferId: string, turnId: string): Promise<MailboxTransfer> {
    return this.#appendComputed(() => {
      const transfer = this.#conversationHistory.mailboxTransferById.get(transferId);
      if (!transfer) throw new LocalStateError("The mailbox transfer is not available.", 404);
      if (transfer.destinationTurnId && transfer.destinationTurnId !== turnId) {
        throw new LocalStateError("The mailbox transfer is already bound to another turn.", 409);
      }
      if (transfer.destinationTurnId === turnId) return { event: null, value: transfer };
      const next: MailboxTransfer = { ...transfer, destinationTurnId: turnId };
      return { event: { type: "mailbox_transfer_saved", mailboxTransfer: next }, value: next };
    });
  }

  async bindAutomationFireTurn(fireId: string, turnId: string): Promise<void> {
    await this.#appendComputed(() => {
      const fire = this.#conversationHistory.automationFireById.get(fireId);
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
    return this.#appendComputed(() => {
      const fire = this.#conversationHistory.automationFireById.get(fireId);
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
    await this.#ensureLoaded();
    await this.#writeQueue;
    const fire = this.#conversationHistory.automationFireById.get(fireId);
    if (!fire) throw new LocalStateError("The automation fire is missing from local history.", 404);
    if (fire.status !== "started" && fire.status !== "skipped_busy") {
      return { status: fire.status, error: fire.error };
    }
    const threadId = fire.turnId
      ? this.#conversationHistory.threadIdByTurn.get(fire.turnId)
      : undefined;
    const turn =
      fire.turnId && threadId
        ? this.#turnsByThread.get(threadId)?.find((item) => item.id === fire.turnId)
        : undefined;
    return automationFireOutcome(this.#projection, fire, new Map(turn ? [[turn.id, turn]] : []));
  }

  async reconcileAutomationFires(): Promise<void> {
    await this.#appendComputed((projection) => {
      const events: StateEvent[] = [];
      const startedFires = projection.automationFires.filter((fire) => fire.status === "started");
      if (startedFires.length === 0) return { event: events, value: undefined };
      const pendingTurnIds = new Set(
        startedFires.flatMap((fire) => (fire.turnId ? [fire.turnId] : [])),
      );
      const turnById = new Map<string, Turn>();
      for (
        let index = projection.turns.length - 1;
        index >= 0 && pendingTurnIds.size > 0;
        index -= 1
      ) {
        const turn = projection.turns[index];
        if (!turn || !pendingTurnIds.delete(turn.id)) continue;
        turnById.set(turn.id, turn);
      }
      for (const fire of startedFires) {
        const outcome = automationFireOutcome(projection, fire, turnById);
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
      const assertConfigurationCapacity = <T extends { id: string }>(
        current: readonly T[],
        proposed: readonly T[],
        label: string,
      ) => {
        const newIds = new Set<string>();
        for (const item of proposed) {
          if (current.some((existing) => existing.id === item.id)) continue;
          newIds.add(item.id);
        }
        if (
          newIds.size > 0 &&
          current.length + newIds.size > MAX_AUTONOMY_CONFIGURATIONS_PER_KIND
        ) {
          throw new LocalStateError(`Autonomy ${label} inventory is full.`, 429);
        }
      };
      assertConfigurationCapacity(
        projection.heartbeatMonitors,
        input.heartbeatMonitors ?? [],
        "heartbeat",
      );
      assertConfigurationCapacity(
        projection.standingOrders,
        input.standingOrders ?? [],
        "standing order",
      );
      assertConfigurationCapacity(projection.autonomyHooks, input.hooks ?? [], "hook");
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
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
      const trimmed = title.trim();
      if (!trimmed) throw new LocalStateError("A conversation title is required.", 400);
      const saved = {
        ...thread,
        title: trimmed.slice(0, 120),
        updatedAt: new Date().toISOString(),
      };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  async setConversationPinned(threadId: string, pinned: boolean): Promise<Thread> {
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
      const now = new Date().toISOString();
      const saved = { ...thread, pinnedAt: pinned ? now : null, updatedAt: now };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  async archiveConversation(threadId: string): Promise<Thread> {
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
      this.#assertConversationSettled(
        this.#turnsByThread.get(threadId) ?? [],
        threadId,
        "archived",
      );
      const now = new Date().toISOString();
      const saved = { ...thread, archivedAt: now, updatedAt: now };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  async restoreConversation(threadId: string): Promise<Thread> {
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
      const saved = { ...thread, archivedAt: null, updatedAt: new Date().toISOString() };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  /**
   * Sidebar settle: reversible, independent of archive, and never touches the worktree.
   * Idempotent — an already-settled thread is returned unchanged.
   * Settling clears any active snooze so presentation stays mutually exclusive.
   */
  async settleConversation(threadId: string): Promise<Thread> {
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
      this.#assertConversationSettled(this.#turnsByThread.get(threadId) ?? [], threadId, "settled");
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
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
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
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
      this.#assertConversationSnoozable(this.#turnsByThread.get(threadId) ?? [], threadId);
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
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
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
    return this.#appendComputed(() => {
      const thread = this.#requireIndexedThread(threadId);
      // Visit is read-tracking only — do not bump updatedAt or the inbox resorts on every click.
      const saved = { ...thread, lastVisitedAt: new Date().toISOString() };
      return { event: { type: "thread_saved", thread: saved }, value: saved };
    });
  }

  async previewConversationDeletion(
    threadId: string,
  ): Promise<ConversationDeletion["affectedRecords"]> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const projection = this.#projection;
    this.#requireThread(projection, threadId);
    this.#assertConversationSettled(projection.turns, threadId, "deleted");
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
    await this.#ensureLoaded();
    await this.#writeQueue;
    const projection = this.#projection;
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
      if (request.responseMode !== "native_resume") {
        const usageReceipt = projection.usageReceipts.find(
          (receipt) => receipt.turnId === turn.id && receipt.status === "running",
        );
        if (usageReceipt) {
          replaceById(projection.usageReceipts, {
            ...usageReceipt,
            status: "completed",
            updatedAt: now,
          });
        }
      }
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
    await this.#ensureLoaded();
    await this.#writeQueue;
    const request = this.#conversationHistory.inputRequestById.get(requestId);
    if (!request) throw new LocalStateError("The input request is not available.", 404);
    if (request.state !== "pending") {
      throw new LocalStateError("The input request has already been resolved.", 409);
    }
    const thread = this.#conversationHistory.threadById.get(request.threadId);
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
    const turn = (this.#turnsByThread.get(request.threadId) ?? []).find(
      (item) => item.id === request.turnId && item.providerRunId === request.providerRunId,
    );
    if (!turn || turn.status !== "waiting_for_user") {
      throw new LocalStateError("The input request is stale.", 409);
    }
    return structuredClone(request);
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
        const interruptedAt = new Date().toISOString();
        replaceById(projection.turns, {
          ...turn,
          status: "interrupted",
          completedAt: interruptedAt,
        });
        const usageReceipt = projection.usageReceipts.find(
          (receipt) => receipt.turnId === turn.id && receipt.status === "running",
        );
        if (usageReceipt) {
          replaceById(projection.usageReceipts, {
            ...usageReceipt,
            status: "interrupted",
            updatedAt: interruptedAt,
          });
        }
      }
    });
  }

  async deleteConversation(threadId: string): Promise<ConversationDeletion> {
    await this.#ensureLoaded();
    await this.#writeQueue;
    const projection = this.#projection;
    const existingDeletion = projection.conversationDeletions.find(
      (item) => item.threadId === threadId && item.status !== "completed",
    );
    const thread = projection.threads.find((item) => item.id === threadId);
    if (!thread && !existingDeletion) {
      throw new LocalStateError("The selected conversation is not available.", 404);
    }
    if (thread) this.#assertConversationSettled(projection.turns, threadId, "deleted");
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

  #requireIndexedThread(threadId: string): Thread {
    const thread = this.#conversationHistory.threadById.get(threadId);
    if (!thread) throw new LocalStateError("The selected conversation is not available.", 404);
    return thread;
  }

  #assertConversationSettled(
    turns: readonly Turn[],
    threadId: string,
    action: "archived" | "deleted" | "settled",
  ): void {
    const blocking = turns.find(
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
  #assertConversationSnoozable(turns: readonly Turn[], threadId: string): void {
    const blocking = turns.find(
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
      usageReceipts: projection.usageReceipts.filter((receipt) => receipt.threadId === threadId)
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
      mailboxTransfers: projection.mailboxTransfers.filter(
        (transfer) =>
          transfer.sourceThreadId === threadId || transfer.destinationThreadId === threadId,
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
    projection.usageReceipts = projection.usageReceipts.filter(
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
    const now = new Date().toISOString();
    for (const transfer of projection.mailboxTransfers) {
      if (transfer.sourceThreadId !== threadId || !transfer.destinationTurnId) continue;
      const destIndex = projection.turns.findIndex(
        (turn) => turn.id === transfer.destinationTurnId,
      );
      if (destIndex < 0) continue;
      const destTurn = projection.turns[destIndex]!;
      if (destTurn.status === "active" && !destTurn.providerRunId) {
        projection.turns[destIndex] = {
          ...destTurn,
          status: "interrupted",
          completedAt: now,
        };
      }
    }
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
    projection.mailboxTransfers = projection.mailboxTransfers.filter(
      (transfer) =>
        transfer.sourceThreadId !== threadId && transfer.destinationThreadId !== threadId,
    );
    projection.threads = projection.threads.map((thread) =>
      thread.parentThreadId === threadId || (thread.forkId && removedForkIds.has(thread.forkId))
        ? { ...thread, parentThreadId: undefined, forkId: undefined }
        : thread,
    );
  }

  async recoverInterruptedTurns(): Promise<void> {
    await this.#compact((current) => {
      let changed = false;
      const inputReceiptByRequest = new Map(
        current.inputReceipts.map((receipt) => [receipt.requestId, receipt]),
      );
      const turnById = new Map(current.turns.map((turn) => [turn.id, turn]));
      const threadById = new Map(current.threads.map((thread) => [thread.id, thread]));
      const usageReceiptByTurn = new Map(
        current.usageReceipts.map((receipt) => [receipt.turnId, receipt]),
      );
      const followUpPrefix = "Operator response to child input request ";
      const followUpAtByRequestAndThread = new Map<string, string>();
      const followUpKey = (requestId: string, threadId: string) => `${requestId}\0${threadId}`;
      for (const message of current.messages) {
        if (message.role !== "user" || !message.text.startsWith(followUpPrefix)) continue;
        const requestIdEnd = message.text.indexOf(":", followUpPrefix.length);
        if (requestIdEnd < 0) continue;
        const requestId = message.text.slice(followUpPrefix.length, requestIdEnd);
        const turn = turnById.get(message.turnId);
        if (!turn) continue;
        const key = followUpKey(requestId, turn.threadId);
        const previous = followUpAtByRequestAndThread.get(key);
        if (!previous || message.createdAt > previous) {
          followUpAtByRequestAndThread.set(key, message.createdAt);
        }
      }
      for (const request of current.inputRequests) {
        if (request.state !== "answered" || request.responseMode !== "child_follow_up") continue;
        const receipt = inputReceiptByRequest.get(request.id);
        if (!receipt) continue;
        const persistedFollowUpAt = followUpAtByRequestAndThread.get(
          followUpKey(request.id, request.threadId),
        );
        const persistedFollowUp = Boolean(
          persistedFollowUpAt && persistedFollowUpAt >= receipt.createdAt,
        );
        if (persistedFollowUp) continue;
        changed = true;
        replaceById(current.inputRequests, {
          ...request,
          state: "pending",
          answeredAt: null,
        });
        current.inputReceipts = current.inputReceipts.filter((item) => item.id !== receipt.id);
        const sourceTurn = turnById.get(request.turnId);
        if (sourceTurn) {
          const reopenedTurn = {
            ...sourceTurn,
            status: "waiting_for_user",
            completedAt: null,
          } as Turn;
          replaceById(current.turns, reopenedTurn);
          turnById.set(reopenedTurn.id, reopenedTurn);
        }
      }
      const unavailableMessage = "Native Shikigami resume is unavailable after the host restarted.";
      for (const request of current.inputRequests) {
        if (request.responseMode !== "native_resume") continue;
        const thread = threadById.get(request.threadId);
        if (thread?.provider !== "shikigami" || request.resumeState === "unavailable") continue;
        changed = true;
        replaceById(current.inputRequests, {
          ...request,
          resumeState: "unavailable",
          resumeError: unavailableMessage,
        });
        const sourceTurn = turnById.get(request.turnId);
        if (
          sourceTurn &&
          ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(
            sourceTurn.status,
          )
        ) {
          const interruptedAt = new Date().toISOString();
          const interruptedTurn = {
            ...sourceTurn,
            status: "interrupted",
            completedAt: interruptedAt,
          } as Turn;
          replaceById(current.turns, interruptedTurn);
          turnById.set(interruptedTurn.id, interruptedTurn);
          const usageReceipt = usageReceiptByTurn.get(sourceTurn.id);
          if (usageReceipt?.status === "running") {
            const interruptedUsageReceipt = {
              ...usageReceipt,
              status: "interrupted",
              updatedAt: interruptedAt,
            } as UsageReceipt;
            replaceById(current.usageReceipts, interruptedUsageReceipt);
            usageReceiptByTurn.set(interruptedUsageReceipt.turnId, interruptedUsageReceipt);
          }
        }
      }
      return changed;
    });
    await this.#writeQueue;
    const projection = this.#projection;
    const threadById = new Map(projection.threads.map((thread) => [thread.id, thread]));
    const nativeInputsByTurn = new Map<string, ChildInputRequest[]>();
    for (const request of projection.inputRequests) {
      if (
        request.state !== "pending" ||
        request.responseMode !== "native_resume" ||
        threadById.get(request.threadId)?.provider === "shikigami"
      ) {
        continue;
      }
      const requests = nativeInputsByTurn.get(request.turnId);
      if (requests) requests.push(request);
      else nativeInputsByTurn.set(request.turnId, [request]);
    }
    for (const turn of projection.turns) {
      const nativeInputs =
        turn.status === "waiting_for_user" ? (nativeInputsByTurn.get(turn.id) ?? []) : [];
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
      const interruptedAt = new Date().toISOString();
      await this.#append({
        type: "turn_saved",
        turn: {
          ...turn,
          status: "interrupted",
          completedAt: interruptedAt,
        },
      });
      const thread = threadById.get(turn.threadId);
      if (thread) {
        await this.#saveUsageReceipt(
          turn.threadId,
          turn.id,
          thread.provider,
          "interrupted",
          interruptedAt,
        );
      }
    }
  }

  async #markThreadWoke(threadId: string, at: string): Promise<void> {
    const { thread } = await this.#inspectProviderEventContext(threadId);
    if (!thread) return;
    if (thread.wokeAt === at) return;
    await this.#append({
      type: "thread_saved",
      thread: { ...thread, wokeAt: at, updatedAt: at },
    });
  }

  async #saveUsageReceipt(
    threadId: string,
    turnId: string,
    provider: ProviderId,
    status: UsageReceiptStatus,
    now: string,
    usage?: Extract<ProviderEvent, { kind: "context_usage" }>,
    reportedCostUsd?: number | null,
  ): Promise<void> {
    const context = await this.#inspectProviderEventContext(threadId, turnId);
    const { thread, turn } = context;
    if (!thread || !turn)
      throw new LocalStateError("The provider turn is missing from local history.");
    const existing = context.usageReceipts.find((receipt) => receipt.turnId === turnId);
    const providerSession = context.providerSessions.find(
      (session) => session.provider === provider,
    );
    const boundedMetric = (value: number | null | undefined, maximum: number): number | null =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
        ? value
        : null;
    const metric = (value: number | null | undefined, previous: number | null): number | null =>
      boundedMetric(value, MAX_USAGE_TOKENS) ?? boundedMetric(previous, MAX_USAGE_TOKENS);
    const boundedCost = (value: number | null | undefined): number | null =>
      boundedMetric(value, MAX_USAGE_COST_USD);
    const hasReportedCost = boundedCost(reportedCostUsd) !== null;
    const hasUsageMetric = [
      usage?.inputTokens,
      usage?.outputTokens,
      usage?.cachedInputTokens,
      usage?.cacheWriteInputTokens,
      usage?.reasoningOutputTokens,
    ].some((value) => boundedMetric(value, MAX_USAGE_TOKENS) !== null);
    if (!existing && !hasUsageMetric && !hasReportedCost) return;
    const cost = hasReportedCost
      ? boundedCost(reportedCostUsd)
      : boundedCost(existing?.reportedCostUsd);
    const nextStatus =
      status === "running" &&
      existing &&
      ["completed", "failed", "interrupted"].includes(existing.status)
        ? existing.status
        : status;
    await this.#append({
      type: "usage_receipt_saved",
      usageReceipt: {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        id: existing?.id ?? `usage:${turnId}`,
        threadId,
        turnId,
        provider,
        model: providerSession?.model ?? thread.model ?? existing?.model ?? null,
        status: nextStatus,
        inputTokens: metric(usage?.inputTokens, existing?.inputTokens ?? null),
        outputTokens: metric(usage?.outputTokens, existing?.outputTokens ?? null),
        cachedInputTokens: metric(usage?.cachedInputTokens, existing?.cachedInputTokens ?? null),
        cacheWriteInputTokens: metric(
          usage?.cacheWriteInputTokens,
          existing?.cacheWriteInputTokens ?? null,
        ),
        reasoningOutputTokens: metric(
          usage?.reasoningOutputTokens,
          existing?.reasoningOutputTokens ?? null,
        ),
        // Cumulative provider totals are live context data, not per-turn
        // usage, so they never enter a new durable receipt.
        totalProcessedTokens: null,
        reportedCostUsd: cost,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
    });
  }

  async recordProviderEvent(
    threadId: string,
    turnId: string,
    provider: ProviderId,
    event: ProviderEvent,
    providerBinding?: { profileId: string; continuationKey: string },
  ): Promise<void> {
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
    if (event.kind === "thinking") {
      // Provider reasoning is a live-only projection. It must not enter the
      // durable transcript, fork context, delegated outcome, or local journal.
      return;
    }
    if (event.kind === "assistant_text") {
      // Buffer stream tokens until a tool, approval, input, or terminal event
      // closes the segment. Avoids one fsync per token on long ACP streams.
      await this.#bufferAssistantText(turnId, event.text);
      return;
    }
    const now = new Date().toISOString();
    // Close the open reply only on true speech boundaries. Metering, plans,
    // session, and governance events may interleave without starting a new
    // assistant segment (and without confusing history coalescing).
    if (
      event.kind === "tool_started" ||
      event.kind === "tool_finished" ||
      event.kind === "failed" ||
      event.kind === "input_requested" ||
      event.kind === "input_resolved" ||
      event.kind === "approval_pending" ||
      event.kind === "approval_resolved" ||
      event.kind === "turn_completed" ||
      event.kind === "cancelled"
    ) {
      await this.#flushOpenAssistant(turnId);
    }
    let cachedContext: ProviderEventContext | undefined;
    const eventContext = async () =>
      (cachedContext ??= await this.#inspectProviderEventContext(threadId, turnId));
    if (event.kind === "input_requested") {
      const { turn } = await eventContext();
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
      const context = await eventContext();
      const request = context.inputRequests.find((item) => item.id === event.id);
      const { turn } = context;
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
        const hasOtherPendingInput = context.inputRequests.some(
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
      const { turn } = await eventContext();
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
    if (event.kind === "context_usage") {
      // The live composer still receives this event, while the bounded numeric
      // fields are also captured as a turn-scoped usage receipt. Prompts,
      // provider payloads, and context-window occupancy remain transient.
      await this.#saveUsageReceipt(threadId, turnId, provider, "running", now, event);
      return;
    }
    if (event.kind === "plan_updated") {
      const context = await eventContext();
      const { turn } = context;
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      if (event.artifact.provider !== provider) {
        throw new LocalStateError("The plan artifact provider does not match the active provider.");
      }
      const id = createHash("sha256")
        .update(`${threadId}\n${turnId}\n${provider}\n${event.artifact.id}`, "utf8")
        .digest("hex");
      const existing = context.plans.find((plan) => plan.id === id);
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
      const context = await eventContext();
      const { turn } = context;
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      const existing = context.governanceCorrelations.find((receipt) => receipt.turnId === turnId);
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
      const current = (await eventContext()).providerSessions.find(
        (item) => item.provider === provider,
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
      const { turn } = await eventContext();
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      await this.#saveUsageReceipt(
        threadId,
        turnId,
        provider,
        event.kind === "turn_completed"
          ? "completed"
          : event.kind === "cancelled"
            ? "interrupted"
            : "failed",
        now,
        undefined,
        event.kind === "turn_completed" || event.kind === "failed" ? event.costUsd : null,
      );
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
      for (const request of (await eventContext()).inputRequests.filter(
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
    return this.#appendComputed(() => {
      if (!this.#conversationHistory.threadById.has(annotation.threadId)) {
        throw new LocalStateError("The annotation conversation is unavailable.", 404);
      }
      const saved: DiffAnnotation = {
        schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
        ...annotation,
        updatedAt: new Date().toISOString(),
      };
      return { event: { type: "annotation_saved", annotation: saved }, value: saved };
    });
  }

  async setAnnotationResolution(
    annotationId: string,
    threadId: string,
    resolution: AnnotationResolution,
  ): Promise<DiffAnnotation> {
    return this.#appendComputed(() => {
      const annotation = this.#conversationHistory.annotationById.get(annotationId);
      if (!annotation || annotation.threadId !== threadId) {
        throw new LocalStateError("The annotation is unavailable.", 404);
      }
      const saved = { ...annotation, resolution, updatedAt: new Date().toISOString() };
      return { event: { type: "annotation_saved", annotation: saved }, value: saved };
    });
  }

  async setFileReview(input: {
    threadId: string;
    path: string;
    previousPath?: string | null;
    diffIdentity: string;
    reviewed: boolean;
  }): Promise<FileReview> {
    const path = input.path.trim();
    const diffIdentity = input.diffIdentity.trim();
    if (!path || !diffIdentity) {
      throw new LocalStateError("A file path and content identity are required.", 400);
    }
    return this.#appendComputed(() => {
      if (!this.#conversationHistory.threadById.has(input.threadId)) {
        throw new LocalStateError("The review conversation is unavailable.", 404);
      }
      const now = new Date().toISOString();
      const existing = this.#conversationHistory.fileReviewByIdentity.get(
        fileReviewIdentity({ threadId: input.threadId, path, diffIdentity }),
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
      return { event: { type: "file_review_saved", fileReview: saved }, value: saved };
    });
  }

  async supersedeCompletedCheckpoints(
    threadId: string,
    worktree: string,
    exceptId: string,
  ): Promise<void> {
    await this.#appendComputed(() => {
      const now = new Date().toISOString();
      const events = (this.#conversationHistory.checkpointsByThread.get(threadId) ?? [])
        .filter(
          (checkpoint) =>
            checkpoint.worktree === worktree &&
            checkpoint.id !== exceptId &&
            checkpoint.state === "completed",
        )
        .map((checkpoint): StateEvent => ({
          type: "checkpoint_saved",
          checkpoint: { ...checkpoint, state: "superseded", updatedAt: now },
        }));
      return { event: events.length > 0 ? events : null, value: undefined };
    });
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
      projection.usageReceipts = projection.usageReceipts.filter(
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
      projection.usageReceipts = projection.usageReceipts.filter(
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
      projection.mailboxTransfers = projection.mailboxTransfers.filter(
        (transfer) =>
          !expiredThreads.has(transfer.sourceThreadId) &&
          !expiredThreads.has(transfer.destinationThreadId),
      );
    });
  }

  async #compact(change: (projection: StateProjection) => void | boolean): Promise<void> {
    await this.#flushAllOpenAssistants();
    await this.#ensureLoaded();
    const operation = this.#enqueueWrite(async () => {
      if (this.#writeFailure) throw this.#writeFailure;
      const next = isolateProjectionCollections(this.#projection);
      const changed = change(next);
      if (changed === false) return;
      // History rewrites always collapse stream-token rows so deletion and
      // retention reclaim fsync-heavy assistant logs from earlier hosts.
      next.messages = coalesceConsecutiveAssistantMessages(next.messages, next.activities);
      const events = function* (): Generator<StateEvent> {
        for (const project of next.projects) yield { type: "project_saved", project };
        for (const thread of next.threads) yield { type: "thread_saved", thread };
        for (const turn of next.turns) yield { type: "turn_saved", turn };
        for (const delegatedRelationship of next.delegatedRelationships) {
          yield { type: "delegated_relationship_saved", delegatedRelationship };
        }
        yield* rewriteTranscriptEvents(next);
        for (const providerSession of next.providerSessions) {
          yield { type: "provider_session_saved", providerSession };
        }
        for (const checkpoint of next.checkpoints) yield { type: "checkpoint_saved", checkpoint };
        for (const annotation of next.annotations) yield { type: "annotation_saved", annotation };
        for (const fileReview of next.fileReviews) yield { type: "file_review_saved", fileReview };
        for (const conversationDeletion of next.conversationDeletions) {
          yield { type: "conversation_deletion_saved", conversationDeletion };
        }
        for (const fork of next.forks) yield { type: "fork_saved", fork };
        for (const inputRequest of next.inputRequests) {
          yield { type: "input_request_saved", inputRequest };
        }
        for (const inputReceipt of next.inputReceipts) {
          yield { type: "input_receipt_saved", inputReceipt };
        }
        for (const mailboxTransfer of next.mailboxTransfers) {
          yield { type: "mailbox_transfer_saved", mailboxTransfer };
        }
        for (const automationFire of next.automationFires) {
          yield { type: "automation_fire_saved", automationFire };
        }
        for (const autonomyRun of next.autonomyRuns) {
          yield { type: "autonomy_run_saved", autonomyRun };
        }
        for (const autonomyTask of next.autonomyTasks) {
          yield { type: "autonomy_task_saved", autonomyTask };
        }
        for (const autonomyFlow of next.autonomyFlows) {
          yield { type: "autonomy_flow_saved", autonomyFlow };
        }
        for (const heartbeatMonitor of next.heartbeatMonitors) {
          yield { type: "heartbeat_monitor_saved", heartbeatMonitor };
        }
        for (const standingOrder of next.standingOrders) {
          yield { type: "standing_order_saved", standingOrder };
        }
        for (const autonomyHook of next.autonomyHooks) {
          yield { type: "autonomy_hook_saved", autonomyHook };
        }
      };
      const rebuilt = emptyProjection();
      const rebuiltTurnsByThread = new Map<string, Turn[]>();
      const rebuiltMessagesByTurn = new Map<string, Map<string, Message>>();
      const rebuiltActivitiesByTurn = new Map<string, Map<string, Activity>>();
      const rebuiltDelegatedChildTurnIds = new Set<string>();
      const envelopes = function* (): Generator<EventEnvelope> {
        let index = 0;
        for (const event of events()) {
          index += 1;
          const envelope: EventEnvelope = {
            schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
            sequence: index,
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            event,
          };
          applyEvent(
            rebuilt,
            envelope,
            undefined,
            rebuiltTurnsByThread,
            rebuiltMessagesByTurn,
            rebuiltActivitiesByTurn,
            rebuiltDelegatedChildTurnIds,
            true,
          );
          yield envelope;
        }
      };
      await this.#replaceHistory(envelopes());
      rebuildDelegatedTranscriptIndexes(
        rebuilt,
        rebuiltMessagesByTurn,
        rebuiltActivitiesByTurn,
        rebuiltDelegatedChildTurnIds,
      );
      this.#projection = rebuilt;
      this.#turnsByThread = rebuiltTurnsByThread;
      this.#messagesByTurn = rebuiltMessagesByTurn;
      this.#activitiesByTurn = rebuiltActivitiesByTurn;
      this.#delegatedChildTurnIds = rebuiltDelegatedChildTurnIds;
      this.#conversationHistory = buildConversationHistoryIndex(rebuilt, rebuiltTurnsByThread);
    });
    await operation;
  }
}
