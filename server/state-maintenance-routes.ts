import type { IncomingMessage, ServerResponse } from "node:http";
import { deleteCheckpointReferences } from "./repository.ts";
import { LocalStateError, type LocalStateStore, type StateProjection } from "./state.ts";

type StateMaintenanceLock = <T>(action: () => Promise<T>) => Promise<T>;

interface StateMaintenanceRouteContext {
  state: Pick<LocalStateStore, "inspect" | "saveCheckpoint" | "deleteProject" | "enforceRetention">;
  managed: boolean;
  activeProjects: Set<string>;
  activeWorktrees: Set<string>;
  assertManagedProject: (projection: StateProjection, projectId: string) => unknown;
  withLock: StateMaintenanceLock;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  deleteCheckpointReferences?: typeof deleteCheckpointReferences;
}

const ROUTES = new Set(["/api/state/projects/delete", "/api/state/retention"]);

function projectHasActiveWorktree(activeWorktrees: Set<string>, projectId: string): boolean {
  const prefix = `[${JSON.stringify(projectId)},`;
  return [...activeWorktrees].some((key) => key.startsWith(prefix));
}

function projectIsActive(context: StateMaintenanceRouteContext, projectId: string): boolean {
  return (
    context.activeProjects.has(projectId) ||
    projectHasActiveWorktree(context.activeWorktrees, projectId)
  );
}

async function invalidateCheckpoints(
  projection: StateProjection,
  threadIds: Set<string>,
  message: string,
  context: StateMaintenanceRouteContext,
): Promise<void> {
  const checkpoints = projection.checkpoints.filter((checkpoint) =>
    threadIds.has(checkpoint.threadId),
  );
  for (const checkpoint of checkpoints) {
    await context.state.saveCheckpoint({
      ...checkpoint,
      state: "unavailable",
      message,
    });
  }
  const removeReferences = context.deleteCheckpointReferences ?? deleteCheckpointReferences;
  for (const checkpoint of checkpoints) {
    if (checkpoint.gitDirectory) {
      await removeReferences(checkpoint.gitDirectory, checkpoint.id);
    }
  }
}

/**
 * Dispatch destructive local-state maintenance behind one interface. The
 * module owns route admission, affected-project exclusion, checkpoint cleanup
 * ordering, persistence coordination, and response mapping. It never removes
 * conversation worktrees.
 */
export async function handleStateMaintenanceRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: StateMaintenanceRouteContext,
): Promise<boolean> {
  if (!ROUTES.has(route)) return false;

  if (route === "/api/state/projects/delete") {
    const body = (await context.readJson(request)) as { projectId?: unknown };
    if (typeof body.projectId !== "string") {
      throw new LocalStateError("A project is required.", 400);
    }
    const projectId = body.projectId;
    await context.withLock(async () => {
      const projection = await context.state.inspect();
      if (context.managed) context.assertManagedProject(projection, projectId);
      if (projectIsActive(context, projectId)) {
        throw new LocalStateError(
          "Wait for the active turn to finish before deleting this project.",
          409,
        );
      }
      context.activeProjects.add(projectId);
      try {
        const threadIds = new Set(
          projection.threads
            .filter((thread) => thread.projectId === projectId)
            .map((thread) => thread.id),
        );
        await invalidateCheckpoints(
          projection,
          threadIds,
          "Checkpoint cleanup is pending project deletion.",
          context,
        );
        await context.state.deleteProject(projectId);
      } finally {
        context.activeProjects.delete(projectId);
      }
    });
    context.sendJson(response, 200, { status: "deleted" });
    return true;
  }

  if (context.managed) {
    throw new LocalStateError(
      "Retention administration is unavailable in managed hosted mode.",
      403,
    );
  }
  const body = (await context.readJson(request)) as { olderThan?: unknown };
  if (typeof body.olderThan !== "string" || Number.isNaN(Date.parse(body.olderThan))) {
    throw new LocalStateError("A valid retention cutoff is required.", 400);
  }
  const cutoff = new Date(body.olderThan);
  await context.withLock(async () => {
    const projection = await context.state.inspect();
    const expiredThreads = new Set(
      projection.threads
        .filter((thread) => new Date(thread.updatedAt) < cutoff)
        .map((thread) => thread.id),
    );
    const expiredProjectIds = new Set(
      projection.threads
        .filter((thread) => expiredThreads.has(thread.id))
        .map((thread) => thread.projectId),
    );
    if ([...expiredProjectIds].some((projectId) => projectIsActive(context, projectId))) {
      throw new LocalStateError(
        "Retention cannot run while an affected project has an active turn.",
        409,
      );
    }
    for (const projectId of expiredProjectIds) context.activeProjects.add(projectId);
    try {
      await invalidateCheckpoints(
        projection,
        expiredThreads,
        "Checkpoint cleanup is pending retention.",
        context,
      );
      await context.state.enforceRetention(cutoff);
    } finally {
      for (const projectId of expiredProjectIds) context.activeProjects.delete(projectId);
    }
  });
  context.sendJson(response, 200, { status: "compacted" });
  return true;
}
