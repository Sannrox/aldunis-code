import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import type { DirectoryBrowser } from "./directory-browser.ts";
import type { ManagedHost } from "./managed-host.ts";
import type { PreferencesStore } from "./preferences.ts";
import {
  collapseProjectsByRepository,
  openRepository,
  RepositoryError,
  repositoryCommonDir,
} from "./repository.ts";
import { LocalStateError, type LocalStateStore } from "./state.ts";
import type { WorktreeManager } from "./worktrees.ts";

interface WorkspaceRouteContext {
  state: LocalStateStore;
  preferences: PreferencesStore;
  worktrees: WorktreeManager;
  directories: DirectoryBrowser;
  activeProjects: Set<string>;
  remoteRequest: boolean;
  remoteHost: boolean;
  managedHost?: ManagedHost;
  selectWorktree: (root: string, worktree: string) => Promise<{ root: string; worktree: string }>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  operations?: {
    collapseProjectsByRepository?: typeof collapseProjectsByRepository;
    openRepository?: typeof openRepository;
    repositoryCommonDir?: typeof repositoryCommonDir;
    managedWorktreePath?: typeof managedWorktreePath;
    randomUUID?: typeof randomUUID;
  };
}

const ROUTES = new Set([
  "/api/repositories/open",
  "/api/projects/list",
  "/api/directories/browse",
  "/api/worktrees/create/preview",
  "/api/worktrees/create",
  "/api/worktrees/remove/preview",
  "/api/worktrees/remove",
]);

async function managedWorktreePath(root: string, branch: string): Promise<string> {
  const parent = dirname(root);
  const [rootDetails, parentDetails] = await Promise.all([stat(root), stat(parent)]);
  if (rootDetails.dev !== parentDetails.dev) {
    throw new RepositoryError(
      "Managed worktree creation requires the repository parent to share its filesystem.",
      403,
    );
  }
  const safeBranch =
    branch
      .trim()
      .replaceAll("/", "-")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 120) || "worktree";
  return join(parent, ".aldunis-worktrees", basename(root), safeBranch);
}

/**
 * Dispatch the closed Conversation workspace route family behind one interface.
 * This module owns repository admission and registration, directory browsing
 * authority, and managed worktree preview-and-approve orchestration.
 */
export async function handleWorkspaceRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: WorkspaceRouteContext,
): Promise<boolean> {
  if (!ROUTES.has(route)) return false;
  const operations = {
    collapseProjectsByRepository,
    openRepository,
    repositoryCommonDir,
    managedWorktreePath,
    randomUUID,
    ...context.operations,
  };
  const managedHost = context.managedHost;

  if (route === "/api/repositories/open") {
    const body = (await context.readJson(request)) as { path?: unknown; repositoryId?: unknown };
    let managedRepositoryId: string | undefined;
    const repository = managedHost
      ? await (async () => {
          if (typeof body.repositoryId !== "string" || body.path !== undefined) {
            throw new RepositoryError("Select a repository from the managed catalogue.", 403);
          }
          const managedRepository = managedHost.repository(body.repositoryId);
          await managedHost.verifyRepository(managedRepository);
          managedRepositoryId = managedRepository.id;
          return operations.openRepository(managedRepository.root);
        })()
      : await (async () => {
          if (typeof body.path !== "string") {
            throw new RepositoryError("A repository path is required.");
          }
          return operations.openRepository(body.path);
        })();
    repository.worktrees = await context.worktrees.list(repository.root);
    const projection = await context.state.inspect();
    let existing = projection.projects.find((project) => project.root === repository.root);
    if (!existing) {
      let commonDir: string | null = null;
      try {
        commonDir = await operations.repositoryCommonDir(
          repository.selectedWorktree || repository.root,
        );
      } catch {
        commonDir = null;
      }
      if (commonDir) {
        for (const candidate of projection.projects) {
          try {
            if ((await operations.repositoryCommonDir(candidate.root)) === commonDir) {
              existing = candidate;
              break;
            }
          } catch {
            // Missing project records cannot identify the opened repository.
          }
        }
      }
    }
    const project = await context.state.saveProject({
      id: existing?.id ?? operations.randomUUID(),
      name: repository.name,
      root: repository.root,
      ...(existing ? { openedAt: existing.openedAt } : {}),
    });
    context.sendJson(response, 200, {
      ...repository,
      projectId: project.id,
      ...(managedRepositoryId ? { managedRepositoryId } : {}),
    });
    return true;
  }

  if (route === "/api/projects/list") {
    const projects = await operations.collapseProjectsByRepository(
      (await context.state.inspect()).projects,
    );
    const visibleProjects = managedHost
      ? projects.filter((project) => {
          try {
            managedHost.repositoryForRoot(project.root);
            return true;
          } catch {
            return false;
          }
        })
      : projects;
    context.sendJson(response, 200, {
      projects: visibleProjects.map((project) => ({
        ...project,
        ...(managedHost
          ? { managedRepositoryId: managedHost.repositoryForRoot(project.root).id }
          : {}),
      })),
      chiseiBindingAdministrationAvailable: !context.remoteRequest && !managedHost,
    });
    return true;
  }

  if (route === "/api/directories/browse") {
    if (context.remoteHost || managedHost) {
      throw new RepositoryError(
        "Remote clients cannot browse the host filesystem without a directory grant.",
        403,
      );
    }
    const body = (await context.readJson(request)) as {
      path?: unknown;
      includeHidden?: unknown;
    };
    if (body.path !== undefined && typeof body.path !== "string") {
      throw new RepositoryError("A directory path must be a string.");
    }
    if (body.includeHidden !== undefined && typeof body.includeHidden !== "boolean") {
      throw new RepositoryError("The hidden-directory option must be a boolean.");
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    context.sendJson(
      response,
      200,
      await context.directories.browse({
        path: body.path,
        includeHidden: body.includeHidden,
        signal: controller.signal,
      }),
    );
    return true;
  }

  if (route === "/api/worktrees/create/preview") {
    const body = (await context.readJson(request)) as {
      root?: unknown;
      base?: unknown;
      branch?: unknown;
      path?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.base !== "string" ||
      typeof body.branch !== "string" ||
      (body.path !== undefined && typeof body.path !== "string")
    ) {
      throw new RepositoryError("A repository, base revision, and new branch are required.");
    }
    const managedRoot = managedHost
      ? (await managedHost.selectWorktree(body.root, body.root)).root
      : body.root;
    if (managedHost && body.path !== undefined) {
      throw new RepositoryError(
        "Managed hosted mode does not accept arbitrary worktree paths.",
        403,
      );
    }
    const managedPath = managedHost
      ? await operations.managedWorktreePath(managedRoot, body.branch)
      : undefined;
    const { preferences } = await context.preferences.load();
    context.sendJson(
      response,
      200,
      await context.worktrees.previewCreate({
        repository: managedRoot,
        base: body.base,
        branch: body.branch,
        ...(managedPath ? { path: managedPath } : {}),
        ...(typeof body.path === "string" ? { path: body.path } : {}),
        limit: preferences.managedWorktreeLimit,
      }),
    );
    return true;
  }

  if (route === "/api/worktrees/create") {
    const body = (await context.readJson(request)) as { planId?: unknown; confirm?: unknown };
    if (typeof body.planId !== "string" || body.confirm !== true) {
      throw new RepositoryError("A complete scoped worktree approval is required.");
    }
    if (managedHost) {
      await managedHost.verifyRepositoryRoot(
        context.worktrees.creationPlan(body.planId).repository,
      );
    }
    const { preferences } = await context.preferences.load();
    const created = await context.worktrees.create(body.planId, preferences.managedWorktreeLimit);
    const repository = await operations.openRepository(created.repository);
    repository.worktrees = await context.worktrees.list(created.repository);
    const project = (await context.state.inspect()).projects.find(
      (candidate) => candidate.root === created.repository,
    );
    const managedRepositoryId = managedHost
      ? managedHost.repositoryForRoot(created.repository).id
      : undefined;
    context.sendJson(response, 200, {
      ...repository,
      projectId: project?.id,
      selectedWorktree: created.path,
      ...(managedRepositoryId ? { managedRepositoryId } : {}),
    });
    return true;
  }

  if (route === "/api/worktrees/remove/preview") {
    const body = (await context.readJson(request)) as { root?: unknown; path?: unknown };
    if (typeof body.root !== "string" || typeof body.path !== "string") {
      throw new RepositoryError("A repository and managed worktree are required.");
    }
    const selection = await context.selectWorktree(body.root, body.path);
    if (
      (await context.state.inspect()).threads.some(
        (thread) => thread.worktree === selection.worktree,
      )
    ) {
      throw new RepositoryError(
        "A conversation is still bound to this worktree. Conversation deletion never removes worktrees; remove or retain that history first.",
        409,
      );
    }
    context.sendJson(
      response,
      200,
      await context.worktrees.previewRemove(selection.root, selection.worktree),
    );
    return true;
  }

  const body = (await context.readJson(request)) as { planId?: unknown; confirm?: unknown };
  if (typeof body.planId !== "string" || body.confirm !== true) {
    throw new RepositoryError("A complete scoped worktree removal approval is required.");
  }
  const plan = context.worktrees.removalPlan(body.planId);
  if (managedHost) await managedHost.verifyRepositoryRoot(plan.repository);
  const project = (await context.state.inspect()).projects.find(
    (candidate) => candidate.root === plan.repository,
  );
  let projectLockAcquired = false;
  try {
    if (project && context.activeProjects.has(project.id)) {
      throw new LocalStateError(
        "Wait for the active conversation operation before removing its worktree.",
        409,
      );
    }
    if (project) {
      context.activeProjects.add(project.id);
      projectLockAcquired = true;
    }
    if ((await context.state.inspect()).threads.some((thread) => thread.worktree === plan.path)) {
      throw new RepositoryError(
        "A conversation became bound to this worktree after preview. Removal was cancelled.",
        409,
      );
    }
    await context.worktrees.remove(body.planId);
  } finally {
    if (project && projectLockAcquired) context.activeProjects.delete(project.id);
    context.worktrees.discardPlan(body.planId);
  }
  context.sendJson(response, 200, { status: "removed" });
  return true;
}
