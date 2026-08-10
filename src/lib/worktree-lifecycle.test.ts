import assert from "node:assert/strict";
import test from "node:test";
import type { RepositoryMetadata, WorktreeCreationPlan, WorktreeRemovalPlan } from "../types";
import { createWorktreeLifecycle } from "./worktree-lifecycle";

const creationPlan: WorktreeCreationPlan = {
  id: "create-1",
  action: "create",
  repository: "/repo",
  base: "main",
  baseRevision: "a".repeat(40),
  branch: "codex/example",
  path: "/repo-worktrees/example",
  expiresAt: "2026-08-10T12:00:00.000Z",
};

const removalPlan: WorktreeRemovalPlan = {
  id: "remove-1",
  action: "remove",
  repository: "/repo",
  branch: "codex/example",
  path: "/repo-worktrees/example",
  expiresAt: "2026-08-10T12:00:00.000Z",
};

const repository: RepositoryMetadata = {
  projectId: "project-1",
  name: "repo",
  root: "/repo",
  defaultBranch: "main",
  selectedWorktree: creationPlan.path,
  worktrees: [],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("worktree lifecycle owns preview, approval, removal, and refresh host contracts", async () => {
  const requests: Array<{ route: string; body: unknown }> = [];
  const replies = [
    creationPlan,
    { ...repository, projectId: undefined },
    removalPlan,
    { status: "removed" },
    repository,
  ];
  const lifecycle = createWorktreeLifecycle(async (input, init) => {
    requests.push({
      route: String(input),
      body: JSON.parse(String(init?.body)) as unknown,
    });
    return response(replies.shift());
  });

  assert.deepEqual(
    await lifecycle.previewCreation(
      { root: "/repo", base: "main", branch: "codex/example" },
      "preview failed",
    ),
    creationPlan,
  );
  assert.deepEqual(
    await lifecycle.approveCreation("create-1", "project-1", "create failed"),
    repository,
  );
  assert.deepEqual(
    await lifecycle.previewRemoval(
      { root: "/repo", path: creationPlan.path },
      "remove preview failed",
    ),
    removalPlan,
  );
  await lifecycle.approveRemoval("remove-1", "remove failed");
  assert.deepEqual(
    await lifecycle.refreshRepository({ repositoryId: "managed-1" }, "refresh failed"),
    repository,
  );
  assert.deepEqual(requests, [
    {
      route: "/api/worktrees/create/preview",
      body: { root: "/repo", base: "main", branch: "codex/example" },
    },
    { route: "/api/worktrees/create", body: { planId: "create-1", confirm: true } },
    {
      route: "/api/worktrees/remove/preview",
      body: { root: "/repo", path: creationPlan.path },
    },
    { route: "/api/worktrees/remove", body: { planId: "remove-1", confirm: true } },
    { route: "/api/repositories/open", body: { repositoryId: "managed-1" } },
  ]);
});

test("worktree lifecycle preserves server errors and rejects malformed successes", async () => {
  const serverFailure = createWorktreeLifecycle(async () =>
    response({ error: "Plan expired." }, 409),
  );
  await assert.rejects(
    serverFailure.approveCreation("expired", "project-1", "Creation failed."),
    /Plan expired\./,
  );

  const malformedSuccess = createWorktreeLifecycle(async () => response({ action: "create" }));
  await assert.rejects(
    malformedSuccess.previewCreation(
      { root: "/repo", base: "main", branch: "codex/example" },
      "Preview failed.",
    ),
    /Preview failed\./,
  );

  await assert.rejects(
    malformedSuccess.approveRemoval("remove-1", "Removal failed."),
    /Removal failed\./,
  );
});
