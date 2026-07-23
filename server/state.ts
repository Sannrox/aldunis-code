import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InteractionMode, ProviderEvent } from "./provider.ts";

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
  createdAt: string;
  updatedAt: string;
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
  provider: "claude-code";
  sessionId: string;
  model: string | null;
  profileId?: string;
  continuationKey?: string;
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
}

type StateEvent =
  | { type: "project_saved"; project: Project }
  | { type: "thread_saved"; thread: Thread }
  | { type: "turn_saved"; turn: Turn }
  | { type: "message_saved"; message: Message }
  | { type: "activity_saved"; activity: Activity }
  | { type: "provider_session_saved"; providerSession: ProviderSessionReference };

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
  };
  const key = payloadKey[event.type as string];
  const payload = key ? event[key] : undefined;
  if (
    !key
    || !isRecord(payload)
    || payload.schemaVersion !== LOCAL_STATE_SCHEMA_VERSION
    || (key === "providerSession"
      ? typeof payload.threadId !== "string" || typeof payload.sessionId !== "string"
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
    const thread: Thread = existing
      ? { ...existing, updatedAt: now }
      : {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          id: randomUUID(),
          projectId: input.projectId,
          title: input.prompt.slice(0, 80),
          worktree: input.worktree,
          createdAt: now,
          updatedAt: now,
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

  async bindProviderRun(turnId: string, providerRunId: string): Promise<void> {
    const turn = (await this.load()).turns.find((item) => item.id === turnId);
    if (!turn) throw new LocalStateError("The provider turn is missing from local history.", 404);
    await this.#append({ type: "turn_saved", turn: { ...turn, providerRunId } });
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
        (item) => item.threadId === threadId && item.provider === "claude-code",
      );
      await this.#append({
        type: "provider_session_saved",
        providerSession: {
          schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
          threadId,
          provider: "claude-code",
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
    });
  }

  async enforceRetention(olderThan: Date): Promise<void> {
    await this.#compact((projection) => {
      const expiredThreads = new Set(
        projection.threads
          .filter((thread) => new Date(thread.updatedAt) < olderThan)
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
