import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ManagedWorktreeStore,
  WorktreeManager,
  type ManagedWorktreeRecord,
} from "./worktrees.ts";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{ data: string; root: string }> {
  const data = await mkdtemp(join(tmpdir(), "aldunis-worktrees-data-"));
  const root = await mkdtemp(join(tmpdir(), "aldunis-worktrees-repo-"));
  await execFileAsync("git", ["init", "-q", "-b", "main", root]);
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C", root,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "baseline",
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
    assert.equal(plan.path, join(await realpath(data), "worktrees", root.split("/").at(-1)!, "codex-isolated"));
    await assert.rejects(() => manager.create("missing", 10), /missing or already used/);

    const created = await manager.create(plan.id, 10);
    assert.equal(created.branch, "codex/isolated");
    assert.equal((await execFileAsync("git", ["-C", created.path, "branch", "--show-current"])).stdout.trim(), "codex/isolated");
    assert.equal((await manager.list(root)).find((item) => item.path === created.path)?.ownership, "aldunis");
    assert.match(await readFile(join(data, "worktrees.v1.json"), "utf8"), /"branch": "codex\/isolated"/);
    await assert.rejects(() => manager.create(plan.id, 10), /missing or already used/);
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("creation rejects dirty, detached, missing-base, branch, path, limit, and lock collisions", async () => {
  const { data, root } = await fixture();
  try {
    const manager = new WorktreeManager(data);
    await writeFile(join(root, "dirty.txt"), "dirty\n");
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "main", branch: "codex/dirty", limit: 10 }),
      /clean repository/,
    );
    await rm(join(root, "dirty.txt"));
    await execFileAsync("git", ["-C", root, "checkout", "--detach", "-q"]);
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "HEAD", branch: "codex/detached", limit: 10 }),
      /detached HEAD/,
    );
    await execFileAsync("git", ["-C", root, "checkout", "main", "-q"]);
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "missing", branch: "codex/missing", limit: 10 }),
      /base revision/,
    );
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "main", branch: "bad name", limit: 10 }),
      /branch name/,
    );
    await execFileAsync("git", ["-C", root, "branch", "existing"]);
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "main", branch: "existing", limit: 10 }),
      /already exists/,
    );
    const occupied = join(data, "occupied");
    await mkdir(occupied);
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "main", branch: "codex/path", path: occupied, limit: 10 }),
      /path already exists/,
    );
    await assert.rejects(
      () => manager.previewCreate({
        repository: root,
        base: "main",
        branch: "codex/nested",
        path: join(root, "nested-worktree"),
        limit: 10,
      }),
      /cannot be inside/,
    );
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "main", branch: "codex/limit", limit: 0 }),
      /managed limit/,
    );
    await writeFile(join(root, ".git", "index.lock"), "");
    await assert.rejects(
      () => manager.previewCreate({ repository: root, base: "main", branch: "codex/locked", limit: 10 }),
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
      () => manager.previewCreate({ repository: root, base: "main", branch: "codex/submodule", limit: 10 }),
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
      (await execFileAsync("git", ["-C", root, "show-ref", "--verify", "refs/heads/codex/remove"])).stdout.length > 0,
      true,
    );

    await execFileAsync("git", ["-C", root, "worktree", "add", "-q", "-b", "user/worktree", userPath, "main"]);
    await assert.rejects(() => manager.previewRemove(root, userPath), /Only Aldunis-owned/);
  } finally {
    await execFileAsync("git", ["-C", root, "worktree", "remove", "--force", userPath]).catch(() => undefined);
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
    assert.equal((await execFileAsync("git", ["-C", record.path, "branch", "--show-current"])).stdout.trim(), record.branch);
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
    await assert.doesNotReject(() => manager.previewCreate({
      repository: root,
      base: "main",
      branch: "codex/after-pending-removal",
      limit: 1,
    }));
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("installation-wide registry updates serialize while branch names remain repository-local", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const manager = new WorktreeManager(first.data);
    const firstPlan = await manager.previewCreate({
      repository: first.root,
      base: "main",
      branch: "feature/shared-name",
      limit: 10,
    });
    const secondPlan = await manager.previewCreate({
      repository: second.root,
      base: "main",
      branch: "feature/shared-name",
      limit: 10,
    });
    const results = await Promise.allSettled([
      manager.create(firstPlan.id, 10),
      manager.create(secondPlan.id, 10),
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
