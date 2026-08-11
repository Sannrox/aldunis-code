import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { openRepository } from "./repository.ts";
import {
  hasStagedChanges,
  ManagedWorktreeStore,
  retainBoundedWorktreePlan,
  WORKTREE_PLAN_LIMIT,
  WorktreeManager,
  type ManagedWorktreeRecord,
  type WorktreePlan,
} from "./worktrees.ts";

const execFileAsync = promisify(execFile);

function creationPlan(id: string, expiresAt: string): WorktreePlan {
  return {
    id,
    action: "create",
    repository: "/repo",
    base: "main",
    baseRevision: "a".repeat(40),
    branch: `codex/${id}`,
    path: `/worktrees/${id}`,
    expiresAt,
  };
}

test("retaining a worktree plan removes expired previews", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const plans = new Map<string, WorktreePlan>([
    ["expired", creationPlan("expired", new Date(now).toISOString())],
    ["pending", creationPlan("pending", new Date(now + 60_000).toISOString())],
  ]);

  retainBoundedWorktreePlan(plans, creationPlan("new", new Date(now + 60_000).toISOString()), now);

  assert.deepEqual([...plans.keys()], ["pending", "new"]);
});

test("retaining worktree plans evicts the oldest preview above the limit", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const plans = new Map<string, WorktreePlan>();
  for (let index = 0; index <= WORKTREE_PLAN_LIMIT; index += 1) {
    const plan = creationPlan(`plan-${index}`, new Date(now + 60_000).toISOString());
    retainBoundedWorktreePlan(plans, plan, now);
  }

  assert.equal(plans.size, WORKTREE_PLAN_LIMIT);
  assert.equal(plans.has("plan-0"), false);
  assert.equal(plans.has("plan-1"), true);
  assert.equal(plans.has(`plan-${WORKTREE_PLAN_LIMIT}`), true);
});

test("staged-change detection consumes rename and copy source paths", () => {
  assert.equal(hasStagedChanges(" R renamed.txt\0original.txt\0"), false);
  assert.equal(hasStagedChanges(" C copied.txt\0original.txt\0"), false);
  assert.equal(hasStagedChanges("R  renamed.txt\0original.txt\0"), true);
  assert.equal(hasStagedChanges("C  copied.txt\0original.txt\0"), true);
});

async function fixture(): Promise<{ data: string; root: string }> {
  const data = await mkdtemp(join(tmpdir(), "aldunis-worktrees-data-"));
  const root = await mkdtemp(join(tmpdir(), "aldunis-worktrees-repo-"));
  await execFileAsync("git", ["init", "-q", "-b", "main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Aldunis Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "aldunis-test@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "baseline",
  ]);
  return { data, root };
}

test("creation previews exact canonical inputs and records only an approved worktree", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    const plan = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/isolated",
      limit: 10,
    });
    const canonicalRoot = await realpath(root);
    assert.equal(plan.repository, canonicalRoot);
    assert.equal(plan.base, "main");
    assert.match(plan.baseRevision, /^[0-9a-f]{40}$/);
    assert.equal(plan.branch, "codex/isolated");
    assert.equal(
      plan.path,
      join(await realpath(data), "worktrees", root.split("/").at(-1)!, "codex-isolated"),
    );
    await assert.rejects(() => manager.create("missing", 10), /missing or already used/);

    const created = await manager.create(plan.id, 10);
    assert.equal(created.branch, "codex/isolated");
    assert.equal(
      (await execFileAsync("git", ["-C", created.path, "branch", "--show-current"])).stdout.trim(),
      "codex/isolated",
    );
    assert.equal(
      (await manager.list(root)).find((item) => item.path === created.path)?.ownership,
      "aldunis",
    );
    assert.match(
      await readFile(join(data, "worktrees.v1.json"), "utf8"),
      /"branch": "codex\/isolated"/,
    );
    await assert.rejects(() => manager.create(plan.id, 10), /missing or already used/);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation honors an explicit operator-selected base branch", async () => {
  const { data, root } = await fixture();
  try {
    await execFileAsync("git", ["-C", root, "branch", "feature"]);
    await execFileAsync("git", ["-C", root, "switch", "-q", "feature"]);
    await writeFile(join(root, "feature.txt"), "feature-only\n");
    await execFileAsync("git", ["-C", root, "add", "feature.txt"]);
    await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "feature commit",
    ]);
    await execFileAsync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    await execFileAsync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "main"]);
    await execFileAsync("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);

    const manager = new WorktreeManager(data);
    const plan = await manager.previewCreate({
      repository: root,
      base: "feature",
      branch: "codex/from-feature",
      limit: 10,
    });

    assert.equal(plan.base, "feature");
    assert.equal(
      plan.baseRevision,
      (await execFileAsync("git", ["-C", root, "rev-parse", "feature"])).stdout.trim(),
    );
    const created = await manager.create(plan.id, 10);
    assert.equal(
      (await execFileAsync("git", ["-C", created.path, "rev-parse", "HEAD"])).stdout.trim(),
      plan.baseRevision,
    );
    assert.equal(await readFile(join(created.path, "feature.txt"), "utf8"), "feature-only\n");
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation falls back to the repository default when base is omitted", async () => {
  const { data, root } = await fixture();
  try {
    await execFileAsync("git", ["-C", root, "branch", "feature"]);
    await execFileAsync("git", ["-C", root, "switch", "-q", "feature"]);
    await writeFile(join(root, "feature.txt"), "feature-only\n");
    await execFileAsync("git", ["-C", root, "add", "feature.txt"]);
    await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "feature commit",
    ]);

    const manager = new WorktreeManager(data);
    const plan = await manager.previewCreate({
      repository: root,
      base: "",
      branch: "codex/default-base",
      limit: 10,
    });

    assert.equal(plan.base, "main");
    const created = await manager.create(plan.id, 10);
    await assert.rejects(() => readFile(join(created.path, "feature.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation rejects an invalid base branch", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "does-not-exist",
          branch: "codex/bad-base",
          limit: 10,
        }),
      /Choose a local branch as the starting base/,
    );
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "HEAD~1",
          branch: "codex/rev-base",
          limit: 10,
        }),
      /Choose a local branch as the starting base/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation accepts a remote-tracking repository default as base", async () => {
  const { data, root } = await fixture();
  try {
    await execFileAsync("git", ["-C", root, "branch", "-m", "main", "develop"]);
    await execFileAsync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    await execFileAsync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "develop"]);
    await execFileAsync("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);

    const repository = await openRepository(root);
    assert.equal(repository.defaultBranch, "origin/main");
    const manager = new WorktreeManager(data);
    const plan = await manager.previewCreate({
      repository: root,
      base: "origin/main",
      branch: "codex/from-remote-default",
      limit: 10,
    });
    assert.equal(plan.base, "origin/main");
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("repository opening remains available when the default branch is ambiguous", async () => {
  const { data, root } = await fixture();
  try {
    await execFileAsync("git", ["-C", root, "branch", "-m", "main", "develop"]);
    await execFileAsync("git", ["-C", root, "branch", "release"]);

    const repository = await openRepository(root);
    assert.equal(repository.defaultBranch, null);
    assert.deepEqual(repository.localBranches, ["develop", "release"]);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation accepts an explicit base when the default branch is unknown", async () => {
  const { data, root } = await fixture();
  try {
    await execFileAsync("git", ["-C", root, "branch", "-m", "main", "feature/only"]);

    const repository = await openRepository(root);
    assert.equal(repository.defaultBranch, null);
    assert.deepEqual(repository.localBranches, ["feature/only"]);
    const manager = new WorktreeManager(data);
    const plan = await manager.previewCreate({
      repository: root,
      base: "feature/only",
      branch: "codex/no-default",
      limit: 10,
    });
    assert.equal(plan.base, "feature/only");
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "",
          branch: "codex/empty-base",
          limit: 10,
        }),
      /Choose a starting branch|default branch could not be determined/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation can use an explicit base when remote default branches disagree", async () => {
  const { data, root } = await fixture();
  try {
    await execFileAsync("git", ["-C", root, "branch", "develop"]);
    await execFileAsync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://example.invalid/origin.git",
    ]);
    await execFileAsync("git", [
      "-C",
      root,
      "remote",
      "add",
      "upstream",
      "https://example.invalid/upstream.git",
    ]);
    await execFileAsync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "main"]);
    await execFileAsync("git", [
      "-C",
      root,
      "update-ref",
      "refs/remotes/upstream/develop",
      "develop",
    ]);
    await execFileAsync("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    await execFileAsync("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/upstream/HEAD",
      "refs/remotes/upstream/develop",
    ]);

    const repository = await openRepository(root);
    assert.equal(repository.defaultBranch, null);
    const manager = new WorktreeManager(data);
    const plan = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/conflicting-default",
      limit: 10,
    });
    assert.equal(plan.base, "main");
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "",
          branch: "codex/no-base",
          limit: 10,
        }),
      /Choose a starting branch/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation excludes unstaged and untracked source changes from the new checkout", async () => {
  const { data, root } = await fixture();
  try {
    await writeFile(join(root, "tracked.txt"), "local unstaged edit\n");
    await writeFile(join(root, "untracked.txt"), "local untracked file\n");

    const manager = new WorktreeManager(data);
    const plan = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/clean-checkout",
      limit: 10,
    });
    const created = await manager.create(plan.id, 10);

    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "local unstaged edit\n");
    assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "local untracked file\n");
    assert.equal(await readFile(join(created.path, "tracked.txt"), "utf8"), "baseline\n");
    await assert.rejects(() => readFile(join(created.path, "untracked.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation rejects staged, detached, branch, path, limit, and lock collisions", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    await writeFile(join(root, "dirty.txt"), "dirty\n");
    await execFileAsync("git", ["-C", root, "add", "dirty.txt"]);
    await assert.rejects(
      () =>
        manager.previewCreate({ repository: root, base: "main", branch: "codex/dirty", limit: 10 }),
      /indexed changes/,
    );
    await execFileAsync("git", ["-C", root, "restore", "--staged", "dirty.txt"]);
    await rm(join(root, "dirty.txt"));
    await execFileAsync("git", ["-C", root, "checkout", "--detach", "-q"]);
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "main",
          branch: "codex/detached",
          limit: 10,
        }),
      /detached HEAD/,
    );
    await execFileAsync("git", ["-C", root, "checkout", "main", "-q"]);
    await assert.rejects(
      () =>
        manager.previewCreate({ repository: root, base: "main", branch: "bad name", limit: 10 }),
      /branch name/,
    );
    await execFileAsync("git", ["-C", root, "branch", "existing"]);
    await assert.rejects(
      () =>
        manager.previewCreate({ repository: root, base: "main", branch: "existing", limit: 10 }),
      /already exists/,
    );
    const occupied = join(data, "occupied");
    await mkdir(occupied);
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "main",
          branch: "codex/path",
          path: occupied,
          limit: 10,
        }),
      /path already exists/,
    );
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "main",
          branch: "codex/nested",
          path: join(root, "nested-worktree"),
          limit: 10,
        }),
      /cannot be inside/,
    );
    await assert.rejects(
      () =>
        manager.previewCreate({ repository: root, base: "main", branch: "codex/limit", limit: 0 }),
      /managed limit/,
    );
    await writeFile(join(root, ".git", "index.lock"), "");
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "main",
          branch: "codex/locked",
          limit: 10,
        }),
      /Git operation is in progress/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation rejects repositories containing submodules", async () => {
  const { data, root } = await fixture();
  const submodule = await mkdtemp(join(tmpdir(), "aldunis-worktree-submodule-"));
  try {
    await execFileAsync("git", ["-C", submodule, "init", "-q", "-b", "main"]);
    await execFileAsync("git", ["-C", submodule, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", submodule, "config", "user.name", "Test"]);
    await writeFile(join(submodule, "README.md"), "submodule\n");
    await execFileAsync("git", ["-C", submodule, "add", "README.md"]);
    await execFileAsync("git", ["-C", submodule, "commit", "-q", "-m", "Initial"]);
    await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submodule,
      "vendor/submodule",
    ]);
    await execFileAsync("git", ["-C", root, "commit", "-q", "-am", "Add submodule"]);

    const manager = new WorktreeManager(data);
    await assert.rejects(
      () =>
        manager.previewCreate({
          repository: root,
          base: "main",
          branch: "codex/submodule",
          limit: 10,
        }),
      /submodules/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(submodule, { recursive: true, force: true });
  }
});

test("removal is single-use, clean-only, owned-only, and preserves the branch", async () => {
  const { data, root } = await fixture();
  const userPath = `${root}-user`;
  try {
    const manager = new WorktreeManager(data);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/remove",
      limit: 10,
    });
    const record = await manager.create(creation.id, 10);
    await writeFile(join(record.path, "dirty.txt"), "dirty\n");
    await assert.rejects(() => manager.previewRemove(root, record.path), /Dirty worktrees/);
    await rm(join(record.path, "dirty.txt"));
    const removal = await manager.previewRemove(root, record.path);
    await manager.remove(removal.id);
    await assert.rejects(() => manager.remove(removal.id), /missing or already used/);
    assert.equal(
      (await execFileAsync("git", ["-C", root, "show-ref", "--verify", "refs/heads/codex/remove"]))
        .stdout.length > 0,
      true,
    );

    await execFileAsync("git", [
      "-C",
      root,
      "worktree",
      "add",
      "-q",
      "-b",
      "user/worktree",
      userPath,
      "main",
    ]);
    await assert.rejects(() => manager.previewRemove(root, userPath), /Only Aldunis-owned/);
  } finally {
    await execFileAsync("git", ["-C", root, "worktree", "remove", "--force", userPath]).catch(
      () => undefined,
    );
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(userPath, { recursive: true, force: true });
  }
});

test("removal treats ignored local files as user data", async () => {
  const { data, root } = await fixture();
  try {
    await writeFile(join(root, ".git", "info", "exclude"), "local.env\n");
    const manager = new WorktreeManager(data);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/ignored",
      limit: 10,
    });
    const record = await manager.create(creation.id, 10);
    await writeFile(join(record.path, "local.env"), "LOCAL_ONLY=true\n");
    await assert.rejects(() => manager.previewRemove(root, record.path), /Dirty worktrees/);
    assert.equal(await readFile(join(record.path, "local.env"), "utf8"), "LOCAL_ONLY=true\n");
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("removal rejects a replacement checkout at the approved path", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/replaced",
      limit: 10,
    });
    const record = await manager.create(creation.id, 10);
    const removal = await manager.previewRemove(root, record.path);
    await execFileAsync("git", ["-C", root, "worktree", "remove", record.path]);
    await execFileAsync("git", ["-C", root, "worktree", "add", record.path, record.branch]);

    await assert.rejects(() => manager.remove(removal.id), /replaced or changed/);
    assert.equal(
      (await execFileAsync("git", ["-C", record.path, "branch", "--show-current"])).stdout.trim(),
      record.branch,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("managed path release removes the checkout without requiring conversation deletion", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/release-me",
      limit: 10,
    });
    const record = await manager.create(creation.id, 10);
    assert.equal(await manager.countActiveManaged(), 1);
    const released = await manager.releaseManagedPath(record.path);
    assert.equal(released.released, true);
    assert.equal(released.count, 0);
    assert.equal(await stat(record.path).catch(() => null), null);
    const again = await manager.releaseManagedPath(record.path);
    assert.equal(again.released, false);
    assert.equal(again.count, 0);
    assert.equal(
      (
        await execFileAsync("git", ["-C", root, "branch", "--list", "codex/release-me"])
      ).stdout.includes("codex/release-me"),
      true,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("post-removal registry failure leaves a recoverable intent outside the active limit", async () => {
  const { data, root } = await fixture();
  class FailingFinalSaveStore extends ManagedWorktreeStore {
    saves = 0;
    override async save(records: ManagedWorktreeRecord[]): Promise<void> {
      this.saves += 1;
      if (this.saves === 3) throw new Error("simulated final save failure");
      await super.save(records);
    }
  }
  try {
    const store = new FailingFinalSaveStore(data);
    const manager = new WorktreeManager(data, store);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/pending-removal",
      limit: 1,
    });
    const record = await manager.create(creation.id, 1);
    const removal = await manager.previewRemove(root, record.path);
    await assert.rejects(() => manager.remove(removal.id), /recoverable pending-removal state/);
    const registry = await store.load();
    const pending = registry.records.find((candidate) => candidate.id === record.id);
    assert.ok(pending?.removalPendingAt);
    assert.equal(pending?.removedAt, null);
    assert.equal(await stat(record.path).catch(() => null), null);
    await assert.doesNotReject(() =>
      manager.previewCreate({
        repository: root,
        base: "main",
        branch: "codex/after-pending-removal",
        limit: 1,
      }),
    );

    const restarted = new WorktreeManager(data);
    const recovered = await restarted.releaseManagedPath(record.path);
    assert.equal(recovered.released, true);
    assert.equal(recovered.count, 0);
    const finalized = (await store.load()).records.find((candidate) => candidate.id === record.id);
    assert.equal(finalized?.removalPendingAt, null);
    assert.ok(finalized?.removedAt);

    const repeated = await restarted.releaseManagedPath(record.path);
    assert.equal(repeated.released, false);
    assert.equal(repeated.count, 0);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("pending-removal retry preserves replaced and moved worktrees", async () => {
  const replaced = await fixture();
  const moved = await fixture();
  try {
    for (const [fixtureValue, branch, mode] of [
      [replaced, "codex/replaced-pending", "replaced"],
      [moved, "codex/moved-pending", "moved"],
    ] as const) {
      const manager = new WorktreeManager(fixtureValue.data);
      const creation = await manager.previewCreate({
        repository: fixtureValue.root,
        base: "main",
        branch,
        limit: 10,
      });
      const record = await manager.create(creation.id, 10);
      const registry = await manager.store.load();
      await manager.store.save(
        registry.records.map((candidate) =>
          candidate.id === record.id
            ? { ...candidate, removalPendingAt: new Date().toISOString() }
            : candidate,
        ),
      );

      if (mode === "replaced") {
        await execFileAsync("git", ["-C", fixtureValue.root, "worktree", "remove", record.path]);
        await mkdir(record.path, { recursive: true });
        await assert.rejects(
          () => new WorktreeManager(fixtureValue.data).releaseManagedPath(record.path),
          /path exists again/,
        );
        assert.ok(await stat(record.path));
      } else {
        const destination = `${record.path}-moved`;
        await execFileAsync("git", [
          "-C",
          fixtureValue.root,
          "worktree",
          "move",
          record.path,
          destination,
        ]);
        await assert.rejects(
          () => new WorktreeManager(fixtureValue.data).releaseManagedPath(record.path),
          /worktree was moved/,
        );
        assert.ok(await stat(destination));
      }
      const retained = (await manager.store.load()).records.find(
        (candidate) => candidate.id === record.id,
      );
      assert.ok(retained?.removalPendingAt);
      assert.equal(retained?.removedAt, null);
    }
  } finally {
    await rm(replaced.data, { recursive: true, force: true });
    await rm(replaced.root, { recursive: true, force: true });
    await rm(moved.data, { recursive: true, force: true });
    await rm(moved.root, { recursive: true, force: true });
  }
});

test("pending-removal retry fails visibly for malformed ownership state", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/malformed-pending",
      limit: 10,
    });
    const record = await manager.create(creation.id, 10);
    await execFileAsync("git", ["-C", root, "worktree", "remove", record.path]);
    await writeFile(
      join(data, "worktrees.v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record, removalPendingAt: 42 }],
      }),
    );

    await assert.rejects(
      () => new WorktreeManager(data).releaseManagedPath(record.path),
      /history is corrupt/,
    );
    assert.equal(
      (
        await execFileAsync("git", ["-C", root, "branch", "--list", "codex/malformed-pending"])
      ).stdout.includes("codex/malformed-pending"),
      true,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("pending-removal retry restores ownership when Git changes during finalization", async () => {
  const { data, root } = await fixture();
  let releaseCommit: (() => void) | undefined;
  const commitMayContinue = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let committed: (() => void) | undefined;
  const commitObserved = new Promise<void>((resolve) => {
    committed = resolve;
  });
  class PausingFinalizationStore extends ManagedWorktreeStore {
    override async save(records: ManagedWorktreeRecord[]): Promise<void> {
      await super.save(records);
      if (records.some((candidate) => candidate.removedAt)) {
        committed?.();
        await commitMayContinue;
      }
    }
  }
  try {
    const store = new PausingFinalizationStore(data);
    const manager = new WorktreeManager(data, store);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/concurrent-recovery",
      limit: 10,
    });
    const record = await manager.create(creation.id, 10);
    await execFileAsync("git", ["-C", root, "worktree", "remove", record.path]);
    const registry = await store.load();
    await store.save(
      registry.records.map((candidate) =>
        candidate.id === record.id
          ? { ...candidate, removalPendingAt: new Date().toISOString() }
          : candidate,
      ),
    );

    const recovery = manager.releaseManagedPath(record.path);
    await commitObserved;
    const moved = `${record.path}-recreated`;
    await execFileAsync("git", ["-C", root, "worktree", "add", moved, record.branch]);
    releaseCommit?.();
    await assert.rejects(recovery, /reappeared during recovery/);

    const preserved = (await store.load()).records.find((candidate) => candidate.id === record.id);
    assert.ok(preserved?.removalPendingAt);
    assert.equal(preserved?.removedAt, null);
    assert.ok(await stat(moved));
  } finally {
    releaseCommit?.();
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("installation-wide registry updates serialize while branch names remain repository-local", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const manager = new WorktreeManager(first.data);
    const secondManager = new WorktreeManager(first.data);
    const firstPlan = await manager.previewCreate({
      repository: first.root,
      base: "main",
      branch: "feature/shared-name",
      limit: 10,
    });
    const secondPlan = await secondManager.previewCreate({
      repository: second.root,
      base: "main",
      branch: "feature/shared-name",
      limit: 10,
    });
    const results = await Promise.allSettled([
      manager.create(firstPlan.id, 10),
      secondManager.create(secondPlan.id, 10),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const rejection = results.find((result) => result.status === "rejected");
    assert.match(String(rejection?.reason), /operation is already active for this installation/);
    const registry = JSON.parse(await readFile(join(first.data, "worktrees.v1.json"), "utf8")) as {
      records: unknown[];
    };
    assert.equal(registry.records.length, 1);
  } finally {
    await rm(first.data, { recursive: true, force: true });
    await rm(first.root, { recursive: true, force: true });
    await rm(second.data, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("restart recovery marks moved and missing owned worktrees without claiming user worktrees", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    const creation = await manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/recovery",
      limit: 10,
    });
    const record = await manager.create(creation.id, 10);
    const moved = `${record.path}-moved`;
    await execFileAsync("git", ["-C", root, "worktree", "move", record.path, moved]);
    const recovered = await new WorktreeManager(data).list(root);
    const movedView = recovered.find((item) => item.path === moved);
    assert.equal(movedView?.ownership, "aldunis");
    assert.equal(movedView?.recovery, "moved");
    assert.equal(movedView?.originalPath, record.path);
    const canonicalRoot = await realpath(root);
    assert.equal(recovered.find((item) => item.path === canonicalRoot)?.ownership, "user");

    await execFileAsync("git", ["-C", root, "worktree", "remove", moved]);
    const missing = await new WorktreeManager(data).list(root);
    assert.equal(missing.find((item) => item.branch === "codex/recovery")?.recovery, "missing");
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
