import type { IncomingMessage, ServerResponse } from "node:http";
import { projectDelegatedApprovals } from "./delegated-approvals.ts";
import { projectDelegatedInputs } from "./delegated-inputs.ts";
import type { ManagedHost } from "./managed-host.ts";
import type { PermissionBroker } from "./permission.ts";
import type { PreferencesStore } from "./preferences.ts";
import {
  LocalStateError,
  type LocalStateStore,
  projectDelegatedConversationOutcomes,
  projectThreadStatuses,
  type DelegatedActivitiesByTurnIndex,
  type DelegatedMessagesByTurnIndex,
  type ConversationHistoryIndex,
  type StateProjection,
  type TurnsByThreadIndex,
} from "./state.ts";
import { projectConversationHistory, projectWorkbenchState } from "./state-projection.ts";
import type { WorktreeManager } from "./worktrees.ts";

export interface WorkbenchProjectionRouteContext {
  state: Pick<LocalStateStore, "inspect"> &
    Partial<
      Pick<
        LocalStateStore,
        | "inspectWorkbenchProjection"
        | "turnsByThreadIndex"
        | "delegatedMessagesByTurnIndex"
        | "delegatedActivitiesByTurnIndex"
      >
    >;
  preferences: Pick<PreferencesStore, "load">;
  permissions: Pick<PermissionBroker, "approvals">;
  worktrees: Pick<WorktreeManager, "inspectActiveManaged">;
  managedHost?: Pick<ManagedHost, "repositoryForRoot">;
  assertManagedThread: (projection: StateProjection, threadId: string) => unknown;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  sendStatus: (response: ServerResponse, status: number) => void;
}

type ThreadSearchProjection = Pick<StateProjection, "projects" | "threads">;
type UsageProjection = Pick<StateProjection, "projects" | "threads" | "turns" | "usageReceipts">;
type ManagedAuxiliaryIndexes = Pick<
  ConversationHistoryIndex,
  "providerSessionsByThread" | "conversationDeletionByThread" | "inputRequestsByThread"
>;

function indexedRowsForThreads<T>(
  threads: StateProjection["threads"],
  rowsByThread: ReadonlyMap<string, readonly T[]>,
): T[] {
  const rows: T[] = [];
  for (const thread of threads) {
    const indexed = rowsByThread.get(thread.id);
    if (indexed) rows.push(...indexed);
  }
  return rows;
}

function indexedDeletionsForThreads(
  threads: StateProjection["threads"],
  deletionByThread: ConversationHistoryIndex["conversationDeletionByThread"],
): StateProjection["conversationDeletions"] {
  const deletions: StateProjection["conversationDeletions"] = [];
  for (const thread of threads) {
    const deletion = deletionByThread.get(thread.id);
    if (deletion) deletions.push(deletion);
  }
  return deletions;
}

function visibleTurnsForThreads(
  projection: Pick<StateProjection, "turns">,
  threads: StateProjection["threads"],
  turnsByThread?: TurnsByThreadIndex,
): StateProjection["turns"] {
  if (!turnsByThread) {
    const threadIds = new Set(threads.map((thread) => thread.id));
    return projection.turns.filter((turn) => threadIds.has(turn.threadId));
  }
  const turns: StateProjection["turns"] = [];
  for (const thread of threads) {
    const indexed = turnsByThread.get(thread.id);
    if (indexed) turns.push(...indexed);
  }
  return turns;
}

const ROUTES = new Set([
  "/api/state/load",
  "/api/state/conversations/history",
  "/api/state/search",
]);

export function filterManagedThreadSearchProjection(
  projection: ThreadSearchProjection,
  managedHost: Pick<ManagedHost, "repositoryForRoot">,
): ThreadSearchProjection {
  const projects = projection.projects.filter((project) => {
    try {
      managedHost.repositoryForRoot(project.root);
      return true;
    } catch {
      return false;
    }
  });
  const projectIds = new Set(projects.map((project) => project.id));
  return {
    projects,
    threads: projection.threads.filter((thread) => projectIds.has(thread.projectId)),
  };
}

export function filterManagedOrchestrationProjection(
  projection: StateProjection,
  managedHost: Pick<ManagedHost, "repositoryForRoot">,
  turnsByThread?: TurnsByThreadIndex,
  includeTranscriptRows = true,
  auxiliaryIndexes?: ManagedAuxiliaryIndexes,
): StateProjection {
  const { projects, threads } = filterManagedThreadSearchProjection(projection, managedHost);
  const threadIds = new Set(threads.map((thread) => thread.id));
  const turns = visibleTurnsForThreads(projection, threads, turnsByThread);
  const turnIds = new Set(turns.map((turn) => turn.id));
  return {
    schemaVersion: projection.schemaVersion,
    sequence: projection.sequence,
    projects,
    threads,
    turns,
    messages: includeTranscriptRows
      ? projection.messages.filter((message) => turnIds.has(message.turnId))
      : [],
    activities: includeTranscriptRows
      ? projection.activities.filter((activity) => turnIds.has(activity.turnId))
      : [],
    plans: [],
    contextReceipts: [],
    usageReceipts: [],
    governanceCorrelations: [],
    providerSessions: auxiliaryIndexes
      ? indexedRowsForThreads(threads, auxiliaryIndexes.providerSessionsByThread)
      : projection.providerSessions.filter((session) => threadIds.has(session.threadId)),
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: auxiliaryIndexes
      ? indexedDeletionsForThreads(threads, auxiliaryIndexes.conversationDeletionByThread)
      : projection.conversationDeletions.filter((deletion) => threadIds.has(deletion.threadId)),
    forks: [],
    delegatedRelationships: projection.delegatedRelationships.filter(
      (relationship) =>
        threadIds.has(relationship.parentThreadId) && threadIds.has(relationship.childThreadId),
    ),
    inputRequests: auxiliaryIndexes
      ? indexedRowsForThreads(threads, auxiliaryIndexes.inputRequestsByThread)
      : projection.inputRequests.filter((item) => threadIds.has(item.threadId)),
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

export function filterManagedUsageReceipts(
  projection: UsageProjection,
  managedHost: Pick<ManagedHost, "repositoryForRoot">,
): StateProjection["usageReceipts"] {
  const { threads } = filterManagedThreadSearchProjection(projection, managedHost);
  const threadIds = new Set(threads.map((thread) => thread.id));
  const turnIds = new Set(
    projection.turns.filter((turn) => threadIds.has(turn.threadId)).map((turn) => turn.id),
  );
  return projection.usageReceipts.filter(
    (receipt) => threadIds.has(receipt.threadId) && turnIds.has(receipt.turnId),
  );
}

export function filterManagedWorkbenchListProjection(
  projection: StateProjection,
  managedHost: Pick<ManagedHost, "repositoryForRoot">,
  turnsByThread?: TurnsByThreadIndex,
  auxiliaryIndexes?: ManagedAuxiliaryIndexes,
): StateProjection {
  const { projects, threads } = filterManagedThreadSearchProjection(projection, managedHost);
  const threadIds = new Set(threads.map((thread) => thread.id));
  return {
    ...projection,
    projects,
    threads,
    turns: visibleTurnsForThreads(projection, threads, turnsByThread),
    messages: [],
    activities: [],
    plans: [],
    contextReceipts: [],
    usageReceipts: [],
    governanceCorrelations: [],
    providerSessions: auxiliaryIndexes
      ? indexedRowsForThreads(threads, auxiliaryIndexes.providerSessionsByThread)
      : projection.providerSessions.filter((session) => threadIds.has(session.threadId)),
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: auxiliaryIndexes
      ? indexedDeletionsForThreads(threads, auxiliaryIndexes.conversationDeletionByThread)
      : projection.conversationDeletions.filter((deletion) => threadIds.has(deletion.threadId)),
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

/**
 * Dispatch Workbench projection reads behind one interface. The module owns
 * coherent snapshot assembly, managed visibility, bounded history and search,
 * and response mapping without changing persistence or host authority.
 */
export async function handleWorkbenchProjectionRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: WorkbenchProjectionRouteContext,
): Promise<boolean> {
  if (!ROUTES.has(route)) return false;
  const {
    state,
    preferences,
    permissions,
    worktrees,
    managedHost,
    readJson,
    sendJson,
    sendStatus,
  } = context;

  if (route === "/api/state/load") {
    // Preferences first so orchestration-disabled installs skip transcript scans.
    const { preferences: currentPreferences } = await preferences.load();
    const indexed = state.inspectWorkbenchProjection
      ? await state.inspectWorkbenchProjection()
      : undefined;
    const projection = (indexed?.projection ?? (await state.inspect())) as StateProjection;
    const turnsByThread =
      indexed?.turnsByThread ??
      (state.turnsByThreadIndex ? await state.turnsByThreadIndex() : undefined);
    const messagesByTurn: DelegatedMessagesByTurnIndex | undefined =
      indexed?.delegatedMessagesByTurn ??
      (state.delegatedMessagesByTurnIndex ? await state.delegatedMessagesByTurnIndex() : undefined);
    const activitiesByTurn: DelegatedActivitiesByTurnIndex | undefined =
      indexed?.delegatedActivitiesByTurn ??
      (state.delegatedActivitiesByTurnIndex
        ? await state.delegatedActivitiesByTurnIndex()
        : undefined);
    const orchestrationEnabled = currentPreferences.orchestrationThreadsBeta;
    const hasDelegatedTranscriptIndexes =
      messagesByTurn !== undefined && activitiesByTurn !== undefined;
    const visibleProjection = managedHost
      ? orchestrationEnabled
        ? filterManagedOrchestrationProjection(
            projection,
            managedHost,
            turnsByThread,
            !hasDelegatedTranscriptIndexes,
            indexed?.conversationHistory,
          )
        : filterManagedWorkbenchListProjection(
            projection,
            managedHost,
            turnsByThread,
            indexed?.conversationHistory,
          )
      : projection;
    // Derive transcript-backed values before the Workbench projection strips them,
    // and before later awaits can observe a newer live-state mutation.
    const delegatedOutcomes = orchestrationEnabled
      ? projectDelegatedConversationOutcomes(
          visibleProjection,
          turnsByThread,
          messagesByTurn,
          activitiesByTurn,
        )
      : [];
    const delegatedInputs = orchestrationEnabled ? projectDelegatedInputs(visibleProjection) : [];
    const delegatedApprovals = orchestrationEnabled
      ? projectDelegatedApprovals(
          visibleProjection,
          permissions.approvals().filter((approval) => {
            if (!managedHost) return true;
            try {
              managedHost.repositoryForRoot(approval.repository);
              return visibleProjection.threads.some(
                (thread) => thread.id === approval.conversationId,
              );
            } catch {
              return false;
            }
          }),
        )
      : [];
    const threadStatuses = projectThreadStatuses(visibleProjection, turnsByThread);
    const workbench = projectWorkbenchState(visibleProjection);
    const managedWorktrees = await worktrees.inspectActiveManaged();
    sendJson(response, 200, {
      ...workbench,
      delegatedRelationships: orchestrationEnabled ? workbench.delegatedRelationships : [],
      delegatedOutcomes,
      delegatedApprovals,
      delegatedInputs,
      threadStatuses,
      managedWorktreeCount: managedWorktrees.count,
      managedWorktreeLimit: currentPreferences.managedWorktreeLimit,
      managedWorktreePaths: managedWorktrees.paths,
    });
    return true;
  }

  if (route === "/api/state/conversations/history") {
    const body = (await readJson(request)) as { threadId?: unknown; knownSequence?: unknown };
    if (typeof body.threadId !== "string" || !body.threadId) {
      throw new LocalStateError("A conversation is required.", 400);
    }
    if (
      body.knownSequence !== undefined &&
      (!Number.isSafeInteger(body.knownSequence) || Number(body.knownSequence) < 0)
    ) {
      throw new LocalStateError("The conversation history sequence is invalid.", 400);
    }
    const indexed = state.inspectWorkbenchProjection
      ? await state.inspectWorkbenchProjection()
      : undefined;
    const projection = (indexed?.projection ?? (await state.inspect())) as StateProjection;
    const thread = indexed?.conversationHistory?.threadById.get(body.threadId);
    if (!(thread ?? projection.threads.find((candidate) => candidate.id === body.threadId))) {
      throw new LocalStateError("The conversation is unavailable.", 404);
    }
    if (managedHost) context.assertManagedThread(projection, body.threadId);
    if (body.knownSequence === projection.sequence) {
      sendStatus(response, 204);
      return true;
    }
    const history = projectConversationHistory(
      projection,
      body.threadId,
      indexed?.conversationHistory,
    );
    if (!history) throw new LocalStateError("The conversation is unavailable.", 404);
    sendJson(response, 200, history);
    return true;
  }

  const body = (await readJson(request)) as { query?: unknown; archived?: unknown };
  if (typeof body.query !== "string") throw new LocalStateError("A search query is required.", 400);
  if (
    body.archived !== undefined &&
    !["exclude", "include", "only"].includes(String(body.archived))
  ) {
    throw new LocalStateError("A valid archived conversation scope is required.", 400);
  }
  const query = body.query.trim().toLocaleLowerCase().slice(0, 120);
  const archived = body.archived ?? "exclude";
  const projection = (await state.inspect()) as StateProjection;
  const visibleProjection = managedHost
    ? filterManagedThreadSearchProjection(projection, managedHost)
    : projection;
  const projects = new Map(visibleProjection.projects.map((project) => [project.id, project]));
  const threads = visibleProjection.threads
    .filter((thread) => {
      if (archived === "exclude" && thread.archivedAt) return false;
      if (archived === "only" && !thread.archivedAt) return false;
      const project = projects.get(thread.projectId);
      return (
        !query ||
        thread.title.toLocaleLowerCase().includes(query) ||
        thread.worktree.toLocaleLowerCase().includes(query) ||
        project?.name.toLocaleLowerCase().includes(query)
      );
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 50)
    .map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      worktree: thread.worktree,
      workspaceMode: thread.workspaceMode ?? "shared",
      provider: thread.provider,
      updatedAt: thread.updatedAt,
      pinnedAt: thread.pinnedAt ?? null,
      archivedAt: thread.archivedAt ?? null,
      projectName: projects.get(thread.projectId)?.name ?? "Unknown project",
    }));
  sendJson(response, 200, { threads, bounded: true });
  return true;
}
