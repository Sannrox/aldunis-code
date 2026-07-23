import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InteractionMode, ProviderEvent, ProviderId } from "./provider.ts";

export const LOCAL_STATE_SCHEMA_VERSION = 1;
export const MAX_THREADS_PER_PROJECT = 200;

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  root: string;
  openedAt: string;
}

export interface Thread {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  worktree: string;
  provider: ProviderId;
  parentThreadId?: string;
  forkId?: string;
  profileId?: string | null;
  model?: string | null;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
}

export type ConversationDeletionStatus = "pending" | "failed" | "completed";

export interface ConversationDeletion {
  schemaVersion: 1;
  threadId: string;
  status: ConversationDeletionStatus;
  affectedRecords: {
    thread: number;
    turns: number;
    messages: number;
    activities: number;
    providerSessions: number;
    checkpoints: number;
    annotations: number;
    forks: number;
  };
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
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
  schemaVersion: 1;
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
  schemaVersion: 1;
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
  schemaVersion: 1;
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface Activity {
  schemaVersion: 1;
  id: string;
  turnId: string;
  kind: "tool_started" | "tool_finished" | "provider_failed";
  toolCallId: string | null;
  name: string | null;
  failed: boolean | null;
  message: string | null;
  createdAt: string;
}

export interface ProviderSessionReference {
  schemaVersion: 1;
  threadId: string;
  provider: ProviderId;
  sessionId: string;
  model: string | null;
  profileId?: string;
  continuationKey?: string;
  updatedAt: string;
}

export type CheckpointState = "baseline" | "completed" | "failed" | "superseded" | "unavailable";

export interface TurnCheckpoint {
  schemaVersion: 1;
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
  createdAt: string;
  updatedAt: string;
}

export type AnnotationResolution = "unresolved" | "resolved";
export type AnnotationScope = "file" | "line";

export interface DiffAnnotation {
  schemaVersion: 1;
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

export interface StateProjection {
  schemaVersion: 1;
  sequence: number;
  projects: Project[];
  threads: Thread[];
  turns: Turn[];
  messages: Message[];
  activities: Activity[];
  providerSessions: ProviderSessionReference[];
  checkpoints: TurnCheckpoint[];
  annotations: DiffAnnotation[];
  conversationDeletions: ConversationDeletion[];
  forks: ConversationFork[];
}

type StateEvent =
  | { type: "project_saved"; project: Project }
  | { type: "thread_saved"; thread: Thread }
  | { type: "turn_saved"; turn: Turn }
  | { type: "message_saved"; message: Message }
  | { type: "activity_saved"; activity: Activity }
  | { type: "provider_session_saved"; providerSession: ProviderSessionReference }
  | { type: "checkpoint_saved"; checkpoint: TurnCheckpoint }
  | { type: "annotation_saved"; annotation: DiffAnnotation }
  | { type: "conversation_deletion_saved"; conversationDeletion: ConversationDeletion }
  | { type: "fork_created"; thread: Thread; fork: ConversationFork }
  | { type: "fork_saved"; fork: ConversationFork };

interface EventEnvelope {
  schemaVersion: 1;
  sequence: number;
  id: string;
  recordedAt: string;
  event: StateEvent;
}

export class LocalStateError extends Error {
  constructor(message: string, readonly status = 500) {
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
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    conversationDeletions: [],
    forks: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceById<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index === -1) items.push(value);
  else items[index] = value;
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
      ...annotations.map((annotation) => (
        `${annotation.path}: ${annotation.text}${annotation.capturedContext
          ? `\nContext: ${annotation.capturedContext}`
          : ""}`
      )),
    );
  }
  sections.push(
    "Excluded by policy: provider credentials, environment values, native session identifiers, hidden reasoning, raw tool inputs and outputs, and approval state.",
  );
  return sections.join("\n\n");
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
  else if (event.type === "message_saved") replaceById(projection.messages, event.message);
  else if (event.type === "activity_saved") replaceById(projection.activities, event.activity);
  else if (event.type === "provider_session_saved") {
    const index = projection.providerSessions.findIndex(
      (item) => item.threadId === event.providerSession.threadId
        && item.provider === event.providerSession.provider,
    );
    if (index === -1) projection.providerSessions.push(event.providerSession);
    else projection.providerSessions[index] = event.providerSession;
  } else if (event.type === "checkpoint_saved") {
    replaceById(projection.checkpoints, event.checkpoint);
  } else if (event.type === "annotation_saved") {
    replaceById(projection.annotations, event.annotation);
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
  if (!isRecord(value) || value.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION) {
    throw new LocalStateError(
      `Local history uses an incompatible schema at line ${lineNumber}.`,
    );
  }
  if (
    typeof value.sequence !== "number"
    || typeof value.id !== "string"
    || typeof value.recordedAt !== "string"
    || !isRecord(value.event)
    || typeof value.event.type !== "string"
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
    provider_session_saved: "providerSession",
    checkpoint_saved: "checkpoint",
    annotation_saved: "annotation",
    conversation_deletion_saved: "conversationDeletion",
    fork_created: "fork",
    fork_saved: "fork",
  };
  const key = payloadKey[event.type as string];
  const payload = key ? event[key] : undefined;
  const forkThread = event.type === "fork_created" ? event.thread : undefined;
  if (
    !key
    || !isRecord(payload)
    || payload.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION
    || (event.type === "fork_created" && (
      !isRecord(forkThread)
      || forkThread.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION
      || typeof forkThread.id !== "string"
    ))
    || (key === "providerSession"
      ? typeof payload.threadId !== "string" || typeof payload.sessionId !== "string"
      : key === "conversationDeletion"
        ? typeof payload.threadId !== "string"
        : typeof payload.id !== "string")
  ) {
    throw new LocalStateError(`Local history is corrupt at line ${lineNumber}.`);
  }
  return value as unknown as EventEnvelope;
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

  async load(): Promise<StateProjection> {
    if (this.#loaded) return structuredClone(this.#projection);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let contents = "";
    try {
      contents = await readFile(this.#eventPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LocalStateError("Local history could not be read.");
      }
    }
    const projection = emptyProjection();
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      applyEvent(projection, parseEnvelope(lines[index], index + 1));
    }
    this.#projection = projection;
    this.#loaded = true;
    return structuredClone(projection);
  }

  async #append(event: StateEvent): Promise<void> {
    await this.load();
    const operation = this.#writeQueue.then(async () => {
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
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async saveProject(input: Omit<Project, "schemaVersion" | "openedAt">): Promise<Project> {
    const project: Project = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      ...input,
      openedAt: new Date().toISOString(),
    };
    await this.#append({ type: "project_saved", project });
    return project;
  }

  async startTurn(input: {
    projectId: string;
    worktree: string;
    prompt: string;
    mode: InteractionMode;
    provider: ProviderId;
    threadId?: string;
  }): Promise<{ thread: Thread; turn: Turn }> {
    const projection = await this.load();
    if (!projection.projects.some((project) => project.id === input.projectId)) {
      throw new LocalStateError("The selected project is not in local history.", 404);
    }
    if (
      !input.threadId
      && projection.threads.filter((thread) => thread.projectId === input.projectId).length
        >= MAX_THREADS_PER_PROJECT
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
    }
    const thread: Thread = existing
      ? { ...existing, provider: existing.provider ?? input.provider, updatedAt: now }
      : {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          id: randomUUID(),
          projectId: input.projectId,
          title: input.prompt.slice(0, 80),
          worktree: input.worktree,
          provider: input.provider,
          createdAt: now,
          updatedAt: now,
          pinnedAt: null,
          archivedAt: null,
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
    await this.#append({ type: "thread_saved", thread });
    await this.#append({ type: "turn_saved", turn });
    await this.#append({ type: "message_saved", message });
    return { thread, turn };
  }

  async createFork(input: {
    sourceThreadId: string;
    provider: ProviderId;
    profileId: string | null;
    model: string;
    worktree: string;
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
    if (
      projection.threads.filter((thread) => thread.projectId === source.projectId).length
      >= MAX_THREADS_PER_PROJECT
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
      worktree: source.worktree,
      provider: input.provider,
      parentThreadId: source.id,
      forkId,
      profileId: input.profileId,
      model: input.model,
      createdAt: now,
      updatedAt: now,
    };
    const fork: ConversationFork = {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      id: forkId,
      sourceThreadId: source.id,
      destinationThreadId: thread.id,
      provider: input.provider,
      profileId: input.profileId,
      model: input.model,
      worktree: source.worktree,
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
    await this.#append({ type: "fork_created", thread, fork });
    return { thread, fork };
  }

  async previewFork(sourceThreadId: string): Promise<{
    sourceThreadId: string;
    sourceProvider: ProviderId;
    worktree: string;
    messages: ForkTransferMessage[];
    annotations: ForkTransferAnnotation[];
    files: [];
    summaries: [];
    prompt: string;
    byteCount: number;
    digest: string;
    excluded: string[];
  }> {
    const projection = await this.load();
    const source = projection.threads.find((thread) => thread.id === sourceThreadId);
    if (!source) throw new LocalStateError("The source conversation is unavailable.", 404);
    const turnIds = new Set(
      projection.turns.filter((turn) => turn.threadId === source.id).map((turn) => turn.id),
    );
    const messages = projection.messages
      .filter((message) => turnIds.has(message.turnId))
      .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt }));
    const annotations = projection.annotations
      .filter((annotation) => annotation.threadId === source.id)
      .map(({ id, path, text, capturedContext }) => ({ id, path, text, capturedContext }));
    const prompt = renderForkPrompt(source, messages, annotations);
    return {
      sourceThreadId: source.id,
      sourceProvider: source.provider,
      worktree: source.worktree,
      messages,
      annotations,
      files: [],
      summaries: [],
      prompt,
      byteCount: Buffer.byteLength(prompt, "utf8"),
      digest: createHash("sha256").update(prompt, "utf8").digest("hex"),
      excluded: [
        "Provider credentials and environment values",
        "Native provider session identifiers",
        "Hidden reasoning",
        "Raw tool inputs and outputs",
        "Tool approvals and runtime activity",
      ],
    };
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
    const turn = (await this.load()).turns.find((item) => item.id === turnId);
    if (!turn) throw new LocalStateError("The provider turn is missing from local history.", 404);
    await this.#append({ type: "turn_saved", turn: { ...turn, providerRunId } });
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

  async previewConversationDeletion(threadId: string): Promise<ConversationDeletion["affectedRecords"]> {
    const projection = await this.load();
    this.#requireThread(projection, threadId);
    this.#assertConversationSettled(projection, threadId, "deleted");
    return this.#conversationRecordCounts(projection, threadId);
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
    action: "archived" | "deleted",
  ): void {
    const blocking = projection.turns.find((turn) => (
      turn.threadId === threadId
      && ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(turn.status)
    ));
    if (!blocking) return;
    const reason = blocking.status === "waiting_for_approval"
      ? "a tool approval is unresolved"
      : blocking.status === "waiting_for_user"
        ? "provider input is unresolved"
        : "provider work is active";
    throw new LocalStateError(
      `This conversation cannot be ${action} because ${reason}. Stop or resolve it, then retry.`,
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
      providerSessions: projection.providerSessions.filter(
        (session) => session.threadId === threadId,
      ).length,
      checkpoints: projection.checkpoints.filter(
        (checkpoint) => checkpoint.threadId === threadId,
      ).length,
      annotations: projection.annotations.filter(
        (annotation) => annotation.threadId === threadId,
      ).length,
      forks: projection.forks.filter(
        (fork) => fork.sourceThreadId === threadId || fork.destinationThreadId === threadId,
      ).length,
    };
  }

  #removeConversationRecords(projection: StateProjection, threadId: string): void {
    const turnIds = new Set(
      projection.turns.filter((turn) => turn.threadId === threadId).map((turn) => turn.id),
    );
    projection.threads = projection.threads.filter((thread) => thread.id !== threadId);
    projection.turns = projection.turns.filter((turn) => turn.threadId !== threadId);
    projection.messages = projection.messages.filter((message) => !turnIds.has(message.turnId));
    projection.activities = projection.activities.filter((activity) => !turnIds.has(activity.turnId));
    projection.providerSessions = projection.providerSessions.filter(
      (session) => session.threadId !== threadId,
    );
    projection.checkpoints = projection.checkpoints.filter(
      (checkpoint) => checkpoint.threadId !== threadId,
    );
    projection.annotations = projection.annotations.filter(
      (annotation) => annotation.threadId !== threadId,
    );
    const removedForkIds = new Set(
      projection.forks
        .filter((fork) => (
          fork.sourceThreadId === threadId || fork.destinationThreadId === threadId
        ))
        .map((fork) => fork.id),
    );
    projection.forks = projection.forks.filter((fork) => !removedForkIds.has(fork.id));
    projection.threads = projection.threads.map((thread) => (
      thread.parentThreadId === threadId || (thread.forkId && removedForkIds.has(thread.forkId))
        ? { ...thread, parentThreadId: undefined, forkId: undefined }
        : thread
    ));
  }

  async recoverInterruptedTurns(): Promise<void> {
    const projection = await this.load();
    for (const turn of projection.turns) {
      if (turn.status !== "active" && turn.status !== "running" && turn.status !== "waiting_for_approval") {
        continue;
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

  async recordProviderEvent(
    threadId: string,
    turnId: string,
    provider: ProviderId,
    event: ProviderEvent,
    providerBinding?: { profileId: string; continuationKey: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    if (event.kind === "approval_pending" || event.kind === "approval_resolved") {
      const turn = (await this.load()).turns.find((item) => item.id === turnId);
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      await this.#append({
        type: "turn_saved",
        turn: {
          ...turn,
          status: event.kind === "approval_pending" && event.state === "pending"
            ? "waiting_for_approval"
            : "active",
        },
      });
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
          model: event.kind === "session_started" ? event.model : current?.model ?? null,
          ...(providerBinding?.profileId ?? current?.profileId
            ? { profileId: providerBinding?.profileId ?? current?.profileId }
            : {}),
          ...(providerBinding?.continuationKey ?? current?.continuationKey
            ? { continuationKey: providerBinding?.continuationKey ?? current?.continuationKey }
            : {}),
          updatedAt: now,
        },
      });
    }
    if (event.kind === "tool_started" || event.kind === "tool_finished" || event.kind === "failed") {
      await this.#append({
        type: "activity_saved",
        activity: {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          id: randomUUID(),
          turnId,
          kind: event.kind === "failed" ? "provider_failed" : event.kind,
          toolCallId: event.kind === "failed" ? null : event.toolCallId,
          name: event.kind === "tool_started" ? event.name : null,
          failed: event.kind === "tool_finished" ? event.failed : event.kind === "failed" ? true : null,
          message: event.kind === "failed" ? "Provider failed." : null,
          createdAt: now,
        },
      });
    }
    if (event.kind === "turn_completed" || event.kind === "cancelled" || event.kind === "failed") {
      const turn = (await this.load()).turns.find((item) => item.id === turnId);
      if (!turn) throw new LocalStateError("The provider turn is missing from local history.");
      await this.#append({
        type: "turn_saved",
        turn: {
          ...turn,
          status: event.kind === "turn_completed" ? "completed" : event.kind === "cancelled" ? "interrupted" : "failed",
          completedAt: now,
        },
      });
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

  async supersedeCompletedCheckpoints(
    threadId: string,
    worktree: string,
    exceptId: string,
  ): Promise<void> {
    const projection = await this.load();
    for (const checkpoint of projection.checkpoints) {
      if (
        checkpoint.threadId === threadId
        && checkpoint.worktree === worktree
        && checkpoint.id !== exceptId
        && checkpoint.state === "completed"
      ) {
        await this.saveCheckpoint({ ...checkpoint, state: "superseded" });
      }
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.#compact((projection) => {
      const threadIds = new Set(
        projection.threads.filter((thread) => thread.projectId === projectId).map((thread) => thread.id),
      );
      const turnIds = new Set(
        projection.turns.filter((turn) => threadIds.has(turn.threadId)).map((turn) => turn.id),
      );
      projection.projects = projection.projects.filter((project) => project.id !== projectId);
      projection.threads = projection.threads.filter((thread) => !threadIds.has(thread.id));
      projection.turns = projection.turns.filter((turn) => !turnIds.has(turn.id));
      projection.messages = projection.messages.filter((message) => !turnIds.has(message.turnId));
      projection.activities = projection.activities.filter((activity) => !turnIds.has(activity.turnId));
      projection.providerSessions = projection.providerSessions.filter(
        (session) => !threadIds.has(session.threadId),
      );
      projection.checkpoints = projection.checkpoints.filter(
        (checkpoint) => !threadIds.has(checkpoint.threadId),
      );
      projection.annotations = projection.annotations.filter(
        (annotation) => !threadIds.has(annotation.threadId),
      );
      projection.forks = projection.forks.filter(
        (fork) => !threadIds.has(fork.sourceThreadId) && !threadIds.has(fork.destinationThreadId),
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
          .filter((thread) => (
            new Date(thread.updatedAt) < olderThan && !protectedByFork.has(thread.id)
          ))
          .map((thread) => thread.id),
      );
      const expiredTurns = new Set(
        projection.turns.filter((turn) => expiredThreads.has(turn.threadId)).map((turn) => turn.id),
      );
      projection.threads = projection.threads.filter((thread) => !expiredThreads.has(thread.id));
      projection.turns = projection.turns.filter((turn) => !expiredTurns.has(turn.id));
      projection.messages = projection.messages.filter((message) => !expiredTurns.has(message.turnId));
      projection.activities = projection.activities.filter((activity) => !expiredTurns.has(activity.turnId));
      projection.providerSessions = projection.providerSessions.filter(
        (session) => !expiredThreads.has(session.threadId),
      );
      projection.checkpoints = projection.checkpoints.filter(
        (checkpoint) => !expiredThreads.has(checkpoint.threadId),
      );
      projection.annotations = projection.annotations.filter(
        (annotation) => !expiredThreads.has(annotation.threadId),
      );
      projection.forks = projection.forks.filter(
        (fork) => (
          !expiredThreads.has(fork.sourceThreadId)
          && !expiredThreads.has(fork.destinationThreadId)
        ),
      );
    });
  }

  async #compact(change: (projection: StateProjection) => void): Promise<void> {
    await this.load();
    const operation = this.#writeQueue.then(async () => {
      const next = structuredClone(this.#projection);
      change(next);
      const events: StateEvent[] = [
        ...next.projects.map((project): StateEvent => ({ type: "project_saved", project })),
        ...next.threads.map((thread): StateEvent => ({ type: "thread_saved", thread })),
        ...next.turns.map((turn): StateEvent => ({ type: "turn_saved", turn })),
        ...next.messages.map((message): StateEvent => ({ type: "message_saved", message })),
        ...next.activities.map((activity): StateEvent => ({ type: "activity_saved", activity })),
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
        ...next.conversationDeletions.map((conversationDeletion): StateEvent => ({
          type: "conversation_deletion_saved",
          conversationDeletion,
        })),
        ...next.forks.map((fork): StateEvent => ({ type: "fork_saved", fork })),
      ];
      const rebuilt = emptyProjection();
      const lines = events.map((event, index) => {
        const envelope: EventEnvelope = {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          sequence: index + 1,
          id: randomUUID(),
          recordedAt: new Date().toISOString(),
          event,
        };
        applyEvent(rebuilt, envelope);
        return JSON.stringify(envelope);
      });
      const temporary = join(this.directory, `.events-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
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
      this.#projection = rebuilt;
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}
