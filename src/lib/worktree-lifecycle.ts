import type { RepositoryMetadata, WorktreeCreationPlan, WorktreeRemovalPlan } from "../types";

type RequestAdapter = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface WorktreeCreationIntent {
  root: string;
  base: string;
  branch: string;
  path?: string;
}

export interface WorktreeRemovalIntent {
  root: string;
  path: string;
}

export type RepositoryRefreshIntent = { path: string } | { repositoryId: string };

export interface WorktreeLifecycle {
  previewCreation(
    intent: WorktreeCreationIntent,
    failureMessage: string,
  ): Promise<WorktreeCreationPlan>;
  approveCreation(
    planId: string,
    projectId: string,
    failureMessage: string,
  ): Promise<RepositoryMetadata>;
  previewRemoval(
    intent: WorktreeRemovalIntent,
    failureMessage: string,
  ): Promise<WorktreeRemovalPlan>;
  approveRemoval(planId: string, failureMessage: string): Promise<void>;
  refreshRepository(
    intent: RepositoryRefreshIntent,
    failureMessage: string,
  ): Promise<RepositoryMetadata>;
}

function serverError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function hasStringFields(body: object, fields: readonly string[]): boolean {
  const record = body as Record<string, unknown>;
  return fields.every((field) => typeof record[field] === "string");
}

function isCreationPlan(body: unknown): body is WorktreeCreationPlan {
  return Boolean(
    typeof body === "object" &&
    body !== null &&
    "action" in body &&
    body.action === "create" &&
    hasStringFields(body, [
      "id",
      "repository",
      "base",
      "baseRevision",
      "branch",
      "path",
      "expiresAt",
    ]),
  );
}

function isRemovalPlan(body: unknown): body is WorktreeRemovalPlan {
  return Boolean(
    typeof body === "object" &&
    body !== null &&
    "action" in body &&
    body.action === "remove" &&
    hasStringFields(body, ["id", "repository", "branch", "path", "expiresAt"]),
  );
}

type RepositoryResponse = Omit<RepositoryMetadata, "projectId"> & { projectId?: string };

function isRepositoryResponse(body: unknown): body is RepositoryResponse {
  return Boolean(
    typeof body === "object" &&
    body !== null &&
    hasStringFields(body, ["name", "root", "selectedWorktree"]) &&
    (!("projectId" in body) || typeof body.projectId === "string") &&
    "defaultBranch" in body &&
    (body.defaultBranch === null || typeof body.defaultBranch === "string") &&
    "selectedWorktree" in body &&
    "worktrees" in body &&
    Array.isArray(body.worktrees),
  );
}

export function createWorktreeLifecycle(
  request: RequestAdapter = (input, init) => globalThis.fetch(input, init),
): WorktreeLifecycle {
  const post = async (route: string, body: unknown, failureMessage: string): Promise<unknown> => {
    const response = await request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(serverError(result, failureMessage));
    return result;
  };

  return {
    async previewCreation(intent, failureMessage) {
      const result = await post("/api/worktrees/create/preview", intent, failureMessage);
      if (!isCreationPlan(result)) throw new Error(failureMessage);
      return result;
    },
    async approveCreation(planId, projectId, failureMessage) {
      const result = await post("/api/worktrees/create", { planId, confirm: true }, failureMessage);
      if (!isRepositoryResponse(result)) throw new Error(failureMessage);
      return { ...result, projectId: result.projectId ?? projectId };
    },
    async previewRemoval(intent, failureMessage) {
      const result = await post("/api/worktrees/remove/preview", intent, failureMessage);
      if (!isRemovalPlan(result)) throw new Error(failureMessage);
      return result;
    },
    async approveRemoval(planId, failureMessage) {
      const result = await post("/api/worktrees/remove", { planId, confirm: true }, failureMessage);
      if (
        typeof result !== "object" ||
        result === null ||
        !("status" in result) ||
        result.status !== "removed"
      ) {
        throw new Error(failureMessage);
      }
    },
    async refreshRepository(intent, failureMessage) {
      const result = await post("/api/repositories/open", intent, failureMessage);
      if (!isRepositoryResponse(result) || !result.projectId) throw new Error(failureMessage);
      return { ...result, projectId: result.projectId };
    },
  };
}

export const worktreeLifecycle = createWorktreeLifecycle();
