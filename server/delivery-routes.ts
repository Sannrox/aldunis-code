import { realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BRANCH_PR_BATCH_LIMIT, inspectBranchPr, inspectBranchPrBatch } from "./branch-pr.ts";
import {
  draftPullRequest,
  inspectDelivery,
  type DeliveryAction,
  type DeliveryBroker,
} from "./delivery.ts";
import {
  type ReleaseDeliveryBroker,
  type ReleaseWorkflowAction,
} from "./release-delivery-workflow.ts";
import { RepositoryError, repositoryCommonDir } from "./repository.ts";
import type { LocalStateStore } from "./state.ts";

interface SelectedWorktree {
  root: string;
  worktree: string;
}

export interface DeliveryRouteContext {
  delivery: DeliveryBroker;
  releaseDelivery: ReleaseDeliveryBroker;
  state: LocalStateStore;
  remote: boolean;
  managed: boolean;
  selectWorktree: (root: string, worktree: string) => Promise<SelectedWorktree>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  inspectBranchPrBatch?: typeof inspectBranchPrBatch;
}

const DELIVERY_ACTIONS = new Set<DeliveryAction>(["stage", "commit", "push", "pull_request"]);
const RELEASE_ACTIONS = new Set<ReleaseWorkflowAction>([
  "prepare",
  "evaluate",
  "publish",
  "promote",
  "plan",
  "apply",
  "reconcile",
  "rollback",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withRequestCancellation<T>(
  request: IncomingMessage,
  response: ServerResponse,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnUnfinishedClose = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", abortOnUnfinishedClose);
  if (request.aborted || (response.destroyed && !response.writableEnded)) abort();
  try {
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    request.removeListener("aborted", abort);
    response.removeListener("close", abortOnUnfinishedClose);
  }
}

async function selectedReleaseProject(
  state: LocalStateStore,
  projectId: string,
  context: SelectedWorktree,
  signal?: AbortSignal,
) {
  const projection = await state.inspect();
  signal?.throwIfAborted();
  const project = projection.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new RepositoryError("The selected release project is unavailable.", 404);
  }
  const contextCommonDir = await repositoryCommonDir(context.root);
  signal?.throwIfAborted();
  const projectCommonDir = await repositoryCommonDir(project.root);
  signal?.throwIfAborted();
  if (projectCommonDir !== contextCommonDir) {
    throw new RepositoryError("The selected release project is unavailable.", 404);
  }
  signal?.throwIfAborted();
  const exactWorktreeProjects: string[] = [];
  let projectRoot: string | undefined;
  for (const candidate of projection.projects) {
    try {
      const candidateCommonDir =
        candidate.id === project.id ? projectCommonDir : await repositoryCommonDir(candidate.root);
      signal?.throwIfAborted();
      if (candidateCommonDir !== contextCommonDir) continue;
      const candidateRoot = await realpath(candidate.root);
      signal?.throwIfAborted();
      if (candidate.id === project.id) projectRoot = candidateRoot;
      if (candidateRoot === context.worktree) {
        exactWorktreeProjects.push(candidate.id);
      }
    } catch {
      signal?.throwIfAborted();
      // Missing project records cannot authorize a local release.
    }
  }
  if (exactWorktreeProjects.length > 0 && !exactWorktreeProjects.includes(project.id)) {
    throw new RepositoryError("The selected release project does not own this worktree.", 404);
  }
  if (exactWorktreeProjects.length === 0) {
    projectRoot ??= await realpath(project.root);
    signal?.throwIfAborted();
    if (projectRoot !== context.root) {
      throw new RepositoryError("The selected release project does not own this worktree.", 404);
    }
  }
  return project;
}

/** Dispatches source-control and capability-linked release delivery without moving authority. */
export async function handleDeliveryRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: DeliveryRouteContext,
): Promise<boolean> {
  const { delivery, releaseDelivery, state, remote, managed, selectWorktree, readJson, sendJson } =
    context;

  if (route === "/api/delivery/inspect") {
    const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
    if (typeof body.root !== "string" || typeof body.worktree !== "string") {
      throw new RepositoryError("A repository and worktree are required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    sendJson(response, 200, await inspectDelivery(selected.root, selected.worktree));
    return true;
  }

  if (route === "/api/delivery/pr-status") {
    const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
    if (typeof body.root !== "string" || typeof body.worktree !== "string") {
      throw new RepositoryError("A repository and worktree are required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    sendJson(response, 200, await inspectBranchPr(selected.worktree));
    return true;
  }

  if (route === "/api/delivery/pr-status/batch") {
    const body = (await readJson(request)) as { items?: unknown };
    if (!Array.isArray(body.items)) {
      throw new RepositoryError("A list of repository worktrees is required.");
    }
    const results = await withRequestCancellation(request, response, async (signal) => {
      const worktrees: string[] = [];
      for (const item of body.items) {
        signal.throwIfAborted();
        if (worktrees.length >= BRANCH_PR_BATCH_LIMIT) break;
        if (!isRecord(item)) continue;
        if (typeof item.root !== "string" || typeof item.worktree !== "string") continue;
        try {
          const selected = await selectWorktree(item.root, item.worktree);
          signal.throwIfAborted();
          worktrees.push(selected.worktree);
        } catch (error) {
          if (signal.aborted) throw error;
          // Released, missing, or out-of-scope paths stay without PR projection.
        }
      }
      return (context.inspectBranchPrBatch ?? inspectBranchPrBatch)(worktrees, signal);
    });
    sendJson(response, 200, { results });
    return true;
  }

  if (route === "/api/delivery/pr-draft") {
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      base?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.base !== "string"
    ) {
      throw new RepositoryError("A repository, worktree, and base branch are required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    sendJson(response, 200, await draftPullRequest(selected.root, selected.worktree, body.base));
    return true;
  }

  const releaseExecution = route.match(/^\/api\/release-delivery\/plans\/([0-9a-f-]+)\/execute$/);
  if (
    route === "/api/release-delivery/inspect" ||
    route === "/api/release-delivery/plans" ||
    route === "/api/release-delivery/receipt" ||
    releaseExecution
  ) {
    if (remote || managed) {
      throw new RepositoryError(
        "Release delivery is available only on the loopback workbench.",
        403,
      );
    }
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      projectId?: unknown;
      action?: unknown;
      input?: unknown;
      sessionId?: unknown;
    };
    const hasReleaseContext =
      typeof body.root === "string" &&
      typeof body.worktree === "string" &&
      typeof body.projectId === "string";
    if (
      route === "/api/release-delivery/plans" &&
      (!hasReleaseContext ||
        typeof body.action !== "string" ||
        !RELEASE_ACTIONS.has(body.action as ReleaseWorkflowAction) ||
        !isRecord(body.input))
    ) {
      throw new RepositoryError("A complete release-delivery action is required.");
    }
    if (
      route === "/api/release-delivery/receipt" &&
      (!hasReleaseContext || typeof body.sessionId !== "string")
    ) {
      throw new RepositoryError("A complete release receipt request is required.");
    }
    if (!hasReleaseContext) {
      throw new RepositoryError("A project, repository, and worktree are required.");
    }
    if (route === "/api/release-delivery/inspect") {
      const inspection = await withRequestCancellation(request, response, async (signal) => {
        const selected = await selectWorktree(body.root, body.worktree);
        signal.throwIfAborted();
        const project = await selectedReleaseProject(state, body.projectId, selected, signal);
        return releaseDelivery.inspect(project.id, selected.root, selected.worktree, signal);
      });
      sendJson(response, 200, inspection);
      return true;
    }
    const selected = await selectWorktree(body.root, body.worktree);
    const project = await selectedReleaseProject(state, body.projectId, selected);
    if (route === "/api/release-delivery/plans") {
      sendJson(
        response,
        200,
        await releaseDelivery.plan(
          project.id,
          selected.root,
          selected.worktree,
          project.chiseiNamespace ?? "",
          body.action as ReleaseWorkflowAction,
          body.input,
        ),
      );
      return true;
    }
    if (releaseExecution) {
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      sendJson(
        response,
        200,
        await releaseDelivery.execute(
          releaseExecution[1],
          project.id,
          selected.root,
          selected.worktree,
          project.chiseiNamespace ?? "",
          controller.signal,
        ),
      );
      return true;
    }
    sendJson(
      response,
      200,
      await releaseDelivery.receipt(body.sessionId, project.id, selected.root, selected.worktree),
    );
    return true;
  }

  if (route === "/api/delivery/plans") {
    if (managed) {
      throw new RepositoryError("Delivery authority is unavailable in managed hosted mode.", 403);
    }
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      action?: unknown;
      input?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.action !== "string" ||
      !DELIVERY_ACTIONS.has(body.action as DeliveryAction) ||
      !isRecord(body.input)
    ) {
      throw new RepositoryError("A complete delivery action is required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    sendJson(
      response,
      200,
      await delivery.plan(
        selected.root,
        selected.worktree,
        body.action as DeliveryAction,
        body.input,
      ),
    );
    return true;
  }

  const deliveryExecution = route.match(/^\/api\/delivery\/plans\/([0-9a-f-]+)\/execute$/);
  if (deliveryExecution) {
    if (managed) {
      throw new RepositoryError("Delivery authority is unavailable in managed hosted mode.", 403);
    }
    const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
    if (typeof body.root !== "string" || typeof body.worktree !== "string") {
      throw new RepositoryError("A repository and worktree are required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    sendJson(
      response,
      200,
      await delivery.execute(deliveryExecution[1], selected.root, selected.worktree),
    );
    return true;
  }

  return false;
}
