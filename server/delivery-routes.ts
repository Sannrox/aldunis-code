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

async function selectedReleaseProject(
  state: LocalStateStore,
  projectId: string,
  context: SelectedWorktree,
) {
  const projection = await state.inspect();
  const project = projection.projects.find((item) => item.id === projectId);
  if (
    !project ||
    (await repositoryCommonDir(project.root)) !== (await repositoryCommonDir(context.root))
  ) {
    throw new RepositoryError("The selected release project is unavailable.", 404);
  }
  const exactWorktreeProjects: string[] = [];
  for (const candidate of projection.projects) {
    try {
      if (
        (await repositoryCommonDir(candidate.root)) === (await repositoryCommonDir(context.root)) &&
        (await realpath(candidate.root)) === context.worktree
      ) {
        exactWorktreeProjects.push(candidate.id);
      }
    } catch {
      // Missing project records cannot authorize a local release.
    }
  }
  if (exactWorktreeProjects.length > 0 && !exactWorktreeProjects.includes(project.id)) {
    throw new RepositoryError("The selected release project does not own this worktree.", 404);
  }
  if (exactWorktreeProjects.length === 0 && (await realpath(project.root)) !== context.root) {
    throw new RepositoryError("The selected release project does not own this worktree.", 404);
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
    const worktrees: string[] = [];
    for (const item of body.items) {
      if (worktrees.length >= BRANCH_PR_BATCH_LIMIT) break;
      if (!isRecord(item)) continue;
      if (typeof item.root !== "string" || typeof item.worktree !== "string") continue;
      try {
        worktrees.push((await selectWorktree(item.root, item.worktree)).worktree);
      } catch {
        // Released, missing, or out-of-scope paths stay without PR projection.
      }
    }
    sendJson(response, 200, { results: await inspectBranchPrBatch(worktrees) });
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
    const selected = await selectWorktree(body.root, body.worktree);
    const project = await selectedReleaseProject(state, body.projectId, selected);

    if (route === "/api/release-delivery/inspect") {
      sendJson(
        response,
        200,
        await releaseDelivery.inspect(project.id, selected.root, selected.worktree),
      );
      return true;
    }
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
