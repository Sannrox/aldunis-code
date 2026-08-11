import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSummary, RepositoryMetadata } from "../src/types.ts";
import {
  activeProjectIds,
  normalizeSplitWorkspaceState,
  projectActivationTarget,
  repositoryForSplitConversation,
  selectSecondaryConversation,
  transitionSplitWorkspace,
} from "../src/split-workspace.ts";

const conversation = (id: string, projectId = "p1", worktree = `/repo/${id}`) =>
  ({
    id,
    projectId,
    worktree,
    title: id,
    provider: "codex-cli",
    updatedAt: "2026-01-01",
  }) as ConversationSummary;

test("split workspace restoration clamps width, removes duplicates, and repairs focus", () => {
  assert.deepEqual(
    normalizeSplitWorkspaceState(
      { primaryId: "t1", secondaryId: "t1", activePane: "secondary", splitPercent: 99 },
      null,
    ),
    { primaryId: "t1", secondaryId: null, activePane: "primary", splitPercent: 70 },
  );
  assert.deepEqual(normalizeSplitWorkspaceState({ splitPercent: Number.NaN }, "fallback"), {
    primaryId: "fallback",
    secondaryId: null,
    activePane: "primary",
    splitPercent: 50,
  });
});

test("split workspace transitions keep panes distinct and focus available", () => {
  const initial = normalizeSplitWorkspaceState({ primaryId: "t1", secondaryId: "t2" }, null);
  const opened = transitionSplitWorkspace(initial, { type: "set_primary", id: "t2" });
  assert.deepEqual(opened, {
    primaryId: "t2",
    secondaryId: null,
    activePane: "primary",
    splitPercent: 50,
  });
  const beside = transitionSplitWorkspace(opened, { type: "set_secondary", id: "t3" });
  assert.equal(beside.activePane, "primary");
  assert.equal(
    transitionSplitWorkspace(beside, { type: "focus", pane: "secondary" }).activePane,
    "secondary",
  );
  assert.equal(transitionSplitWorkspace(beside, { type: "resize", percent: 5 }).splitPercent, 30);
  assert.equal(
    transitionSplitWorkspace({ ...beside, secondaryId: null }, { type: "focus", pane: "secondary" })
      .activePane,
    "primary",
  );
});

test("project activation is membership-aware and deduplicated", () => {
  const memberships = activeProjectIds("p1", [{ id: "p1", memberIds: ["p1-child"] }]);
  const conversations = [conversation("t1", "p2")];
  assert.equal(projectActivationTarget("t1", conversations, memberships, null), "p2");
  assert.equal(projectActivationTarget("t1", conversations, memberships, "p2"), null);
  assert.equal(projectActivationTarget(null, conversations, memberships, null), null);
});

test("secondary selection prefers an eligible same-project conversation", () => {
  const conversations = [
    conversation("primary"),
    { ...conversation("settled"), settledAt: "now" },
    conversation("foreign", "p2"),
    conversation("beside"),
  ];
  assert.equal(
    selectSecondaryConversation(
      undefined,
      conversations,
      "primary",
      new Set(["p1"]),
      () => "new-id",
    ),
    "beside",
  );
  assert.equal(
    selectSecondaryConversation(
      "foreign",
      conversations,
      "primary",
      new Set(["p1"]),
      () => "new-id",
    ),
    "foreign",
  );
  assert.equal(
    selectSecondaryConversation(
      undefined,
      [conversation("primary")],
      "primary",
      new Set(["p1"]),
      () => "new-id",
    ),
    "new:new-id",
  );
});

test("repository projection rejects foreign worktrees", () => {
  const repository = {
    projectId: "p1",
    name: "Repo",
    root: "/repo",
    defaultBranch: "main",
    selectedWorktree: "/repo/main",
    worktrees: [{ path: "/repo/main" }, { path: "/repo/t1" }],
  } as RepositoryMetadata;
  assert.equal(
    repositoryForSplitConversation(repository, conversation("foreign", "p2", "/other/worktree")),
    repository,
  );
  assert.deepEqual(
    repositoryForSplitConversation(repository, { ...conversation("t1"), projectName: "Feature" }),
    { ...repository, selectedWorktree: "/repo/t1", name: "Feature" },
  );
});
