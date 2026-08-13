import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeDiscoveredWorktreePaths,
  classifyDiscoveredWorktrees,
  openRepository,
  WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY,
} from "./repository.ts";

test("repository opening reuses one discovered worktree inventory", async () => {
  const calls: string[] = [];
  const worktrees = [
    { path: "/repo", head: "head", branch: "main", state: "available" as const },
    { path: "/repo-linked", head: "other", branch: "topic", state: "available" as const },
  ];
  const repository = await openRepository("/repo-linked", {
    canonicalize: async (input) => {
      calls.push(`canonicalize:${input}`);
      return input;
    },
    discover: async (root) => {
      calls.push(`discover:${root}`);
      return worktrees;
    },
    resolveMainRoot: async (root, discovered) => {
      calls.push(`main:${root}:${discovered.length}`);
      return discovered[0]?.path ?? root;
    },
    defaultBranch: async (root) => {
      calls.push(`default:${root}`);
      return "main";
    },
    localBranches: async (root) => {
      calls.push(`branches:${root}`);
      return ["main", "topic"];
    },
  });

  assert.equal(calls.filter((call) => call.startsWith("discover:")).length, 1);
  assert.deepEqual(repository, {
    name: "repo",
    root: "/repo",
    defaultBranch: "main",
    localBranches: ["main", "topic"],
    selectedWorktree: "/repo-linked",
    worktrees,
  });
});

test("worktree discovery bounds classification and preserves Git order", async () => {
  const count = WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY * 3;
  const records = Array.from({ length: count }, (_, index) => ({
    worktree: `/worktrees/${index}`,
    HEAD: `head-${index}`,
    branch: `refs/heads/branch-${index}`,
    ...(index === count - 1 ? { detached: true } : {}),
  }));
  const releases: Array<() => void> = [];
  const calls = new Map<string, number>();
  let active = 0;
  let maximumActive = 0;
  let initialPoolStarted!: () => void;
  const initialPool = new Promise<void>((resolve) => {
    initialPoolStarted = resolve;
  });
  const classified = classifyDiscoveredWorktrees(records, async (path, detached) => {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY) initialPoolStarted();
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return detached ? "detached" : "available";
  });

  await initialPool;
  assert.equal(calls.size, WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY);
  while (releases.length > 0) releases.pop()!();
  const releaseRemaining = setInterval(() => {
    while (releases.length > 0) releases.pop()!();
  }, 0);
  const result = await classified.finally(() => clearInterval(releaseRemaining));

  assert.equal(maximumActive, WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY);
  assert.equal(calls.size, count);
  assert.equal(
    [...calls.values()].every((value) => value === 1),
    true,
  );
  assert.deepEqual(
    result.map(({ path, head, branch, state }) => [path, head, branch, state]),
    records.map((record, index) => [
      record.worktree,
      record.HEAD,
      record.branch.replace(/^refs\/heads\//, ""),
      index === count - 1 ? "detached" : "available",
    ]),
  );
});

test("worktree membership bounds canonicalization and omits failed paths", async () => {
  const count = WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY * 3;
  const worktrees = Array.from({ length: count }, (_, index) => ({ path: `/worktrees/${index}` }));
  const releases: Array<() => void> = [];
  const calls = new Map<string, number>();
  let active = 0;
  let maximumActive = 0;
  let initialPoolStarted!: () => void;
  const initialPool = new Promise<void>((resolve) => {
    initialPoolStarted = resolve;
  });
  const canonicalized = canonicalizeDiscoveredWorktreePaths(worktrees, async (path) => {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY) initialPoolStarted();
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    const index = Number(path.split("/").at(-1));
    if (index === 5) throw new Error("missing worktree");
    return index < 2 ? "/canonical/shared" : `/canonical/${index}`;
  });

  await initialPool;
  assert.equal(calls.size, WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY);
  while (releases.length > 0) releases.pop()!();
  const releaseRemaining = setInterval(() => {
    while (releases.length > 0) releases.pop()!();
  }, 0);
  const result = await canonicalized.finally(() => clearInterval(releaseRemaining));

  assert.equal(maximumActive, WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY);
  assert.equal(calls.size, count);
  assert.equal(
    [...calls.values()].every((value) => value === 1),
    true,
  );
  assert.equal(result.size, count - 2);
  assert.equal(result.has("/canonical/shared"), true);
  assert.equal(result.has("/canonical/5"), false);
  assert.equal(result.has(`/canonical/${count - 1}`), true);
});
