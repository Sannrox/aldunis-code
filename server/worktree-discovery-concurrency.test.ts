import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDiscoveredWorktrees,
  WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY,
} from "./repository.ts";

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
