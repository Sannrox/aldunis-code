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
  type StateProjection,
} from "./state.ts";
import { projectConversationHistory, projectWorkbenchState } from "./state-projection.ts";
import type { WorktreeManager } from "./worktrees.ts";

export interface WorkbenchProjectionRouteContext {
  state: Pick<LocalStateStore, "inspect">;
  preferences: Pick<PreferencesStore, "load">;
  permissions: Pick<PermissionBroker, "approvals">;
  worktrees: Pick<WorktreeManager, "countActiveManaged" | "listActiveManagedPaths">;
  managedHost?: Pick<ManagedHost, "repositoryForRoot">;
  assertManagedThread: (projection: StateProjection, threadId: string) => unknown;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  sendStatus: (response: ServerResponse, status: number) => void;
}

const ROUTES = new Set([
  "/api/state/load",
  "/api/state/conversations/history",
  "/api/state/search",
]);

export function filterManagedProjection(
  projection: StateProjection,
  managedHost: Pick<ManagedHost, "repositoryForRoot">,
): StateProjection {
  const projects = projection.projects.filter((project) => {
    try {
      managedHost.repositoryForRoot(project.root);
      return true;
    } catch {
      return false;
    }
  });
  const projectIds = new Set(projects.map((project) => project.id));
  const threads = projection.threads.filter((thread) => projectIds.has(thread.projectId));
  const threadIds = new Set(threads.map((thread) => thread.id));
  const turns = projection.turns.filter((turn) => threadIds.has(turn.threadId));
  const turnIds = new Set(turns.map((turn) => turn.id));
  return {
    ...projection,
    projects,
    threads,
    turns,
    messages: projection.messages.filter((message) => turnIds.has(message.turnId)),
    activities: projection.activities.filter((activity) => turnIds.has(activity.turnId)),
    plans: projection.plans.filter(
      (plan) => threadIds.has(plan.threadId) && turnIds.has(plan.turnId),
    ),
    contextReceipts: projection.contextReceipts.filter(
      (receipt) => threadIds.has(receipt.threadId) && turnIds.has(receipt.turnId),
    ),
    usageReceipts: projection.usageReceipts.filter(
      (receipt) => threadIds.has(receipt.threadId) && turnIds.has(receipt.turnId),
    ),
    governanceCorrelations: projection.governanceCorrelations.filter((receipt) =>
      threadIds.has(receipt.threadId),
    ),
    providerSessions: projection.providerSessions.filter((session) =>
      threadIds.has(session.threadId),
    ),
    checkpoints: projection.checkpoints.filter(
      (checkpoint) => threadIds.has(checkpoint.threadId) && turnIds.has(checkpoint.turnId),
    ),
    annotations: projection.annotations.filter((annotation) => threadIds.has(annotation.threadId)),
    fileReviews: projection.fileReviews.filter((review) => threadIds.has(review.threadId)),
    conversationDeletions: projection.conversationDeletions.filter((deletion) =>
      threadIds.has(deletion.threadId),
    ),
    forks: projection.forks.filter(
      (fork) => threadIds.has(fork.sourceThreadId) && threadIds.has(fork.destinationThreadId),
    ),
    delegatedRelationships: projection.delegatedRelationships.filter(
      (relationship) =>
        threadIds.has(relationship.parentThreadId) && threadIds.has(relationship.childThreadId),
    ),
    inputRequests: projection.inputRequests.filter((item) => threadIds.has(item.threadId)),
    inputReceipts: projection.inputReceipts.filter(
      (receipt) =>
        threadIds.has(receipt.childThreadId) &&
        (receipt.parentThreadId === null || threadIds.has(receipt.parentThreadId)),
    ),
    autonomyRuns: projection.autonomyRuns.filter(
      (run) => run.projectId === null || projectIds.has(run.projectId),
    ),
    autonomyTasks: projection.autonomyTasks.filter((task) => {
      const run = projection.autonomyRuns.find((candidate) => candidate.id === task.runId);
      return run?.projectId === null || (run?.projectId ? projectIds.has(run.projectId) : false);
    }),
    autonomyFlows: projection.autonomyFlows,
    heartbeatMonitors: projection.heartbeatMonitors.filter(
      (monitor) => monitor.projectId === null || projectIds.has(monitor.projectId),
    ),
    standingOrders: projection.standingOrders.filter(
      (order) => order.projectId === null || projectIds.has(order.projectId),
    ),
    autonomyHooks: projection.autonomyHooks.filter(
      (hook) => hook.projectId === null || projectIds.has(hook.projectId),
    ),
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
    const projection = (await state.inspect()) as StateProjection;
    const visibleProjection = managedHost
      ? filterManagedProjection(projection, managedHost)
      : projection;
    // Derive transcript-backed values before the Workbench projection strips them,
    // and before later awaits can observe a newer live-state mutation.
    const orchestrationEnabled = currentPreferences.orchestrationThreadsBeta;
    const delegatedOutcomes = orchestrationEnabled
      ? projectDelegatedConversationOutcomes(visibleProjection)
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
    const workbench = projectWorkbenchState(visibleProjection);
    const threadStatuses = projectThreadStatuses(workbench);
    const managedWorktreeCount = await worktrees.countActiveManaged();
    const managedWorktreePaths = await worktrees.listActiveManagedPaths();
    sendJson(response, 200, {
      ...workbench,
      delegatedRelationships: orchestrationEnabled ? workbench.delegatedRelationships : [],
      delegatedOutcomes,
      delegatedApprovals,
      delegatedInputs,
      threadStatuses,
      managedWorktreeCount,
      managedWorktreeLimit: currentPreferences.managedWorktreeLimit,
      managedWorktreePaths,
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
    const projection = (await state.inspect()) as StateProjection;
    if (!projection.threads.some((thread) => thread.id === body.threadId)) {
      throw new LocalStateError("The conversation is unavailable.", 404);
    }
    if (managedHost) context.assertManagedThread(projection, body.threadId);
    if (body.knownSequence === projection.sequence) {
      sendStatus(response, 204);
      return true;
    }
    const history = projectConversationHistory(projection, body.threadId);
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
    ? filterManagedProjection(projection, managedHost)
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
