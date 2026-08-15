import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  canonicalizeDiscoveredWorktreePaths,
  classifyDiscoveredWorktrees,
  discoverWorktrees,
  MAX_DEFAULT_BRANCH_REMOTES,
  openRepository,
  repositoryDefaultBranch,
  repositoryLocalBranchProjection,
  MAX_LOCAL_BRANCH_SUGGESTIONS,
  WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY,
} from "./repository.ts";

const execFile = promisify(execFileCallback);

async function configuredRemoteFixture(count: number, withHeads: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-default-remotes-"));
  await execFile("git", ["init", "--quiet", directory]);
  await execFile("git", [
    "-C",
    directory,
    "-c",
    "user.name=Aldunis Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await execFile("git", ["-C", directory, "branch", "-M", "main"]);
  const gitDirectory = join(directory, ".git");
  const existingConfig = await readFile(join(gitDirectory, "config"), "utf8");
  const remotes = Array.from(
    { length: count },
    (_, index) => `remote-${String(index).padStart(3, "0")}`,
  );
  await writeFile(
    join(gitDirectory, "config"),
    `${existingConfig}${remotes.map((remote) => `\n[remote "${remote}"]\n\turl = .\n`).join("")}`,
  );
  if (withHeads) {
    const revision = (await execFile("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
    for (const remote of remotes) {
      const remoteDirectory = join(gitDirectory, "refs", "remotes", remote);
      await mkdir(remoteDirectory, { recursive: true });
      await writeFile(join(remoteDirectory, "main"), `${revision}\n`);
      await writeFile(join(remoteDirectory, "HEAD"), `ref: refs/remotes/${remote}/main\n`);
    }
  }
  const calls = join(directory, "git-calls");
  const wrapper = join(directory, "git-fixture");
  await writeFile(
    wrapper,
    `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
exec git "$@"
`,
  );
  await chmod(wrapper, 0o700);
  return { calls, directory, wrapper };
}

test("worktree discovery streams inventories beyond the former one MiB ceiling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-worktree-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "git-fixture");
  const count = 15_000;
  await writeFile(
    fixture,
    `#!/bin/bash
set -eu
i=0
while [ "$i" -lt ${count} ]; do
  printf 'worktree /tmp\\0HEAD 0123456789012345678901234567890123456789\\0branch refs/heads/codex/synthetic-%08d\\0\\0' "$i"
  i=$((i + 1))
done
`,
  );
  await chmod(fixture, 0o700);

  const worktrees = await discoverWorktrees("/tmp", fixture);

  assert.equal(worktrees.length, count);
  assert.deepEqual(worktrees[0], {
    path: "/tmp",
    head: "0123456789012345678901234567890123456789",
    branch: "codex/synthetic-00000000",
    state: "available",
  });
  assert.equal(worktrees.at(-1)?.branch, "codex/synthetic-00014999");
});

test("local branch discovery bounds suggestions while counting inventories beyond one MiB", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-local-branches-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execFile("git", ["init", "--quiet", directory]);
  const fixture = join(directory, "git-fixture");
  const syntheticCount = 80_000;
  await writeFile(
    fixture,
    `#!/bin/bash
set -eu
i=0
while [ "$i" -lt ${syntheticCount} ]; do
  printf 'zz/synthetic-%08d\\n' "$i"
  i=$((i + 1))
done
printf 'main\\n'
`,
  );
  await chmod(fixture, 0o700);

  const projection = await repositoryLocalBranchProjection(directory, fixture);

  assert.equal(projection.count, syntheticCount + 1);
  assert.equal(projection.branches.length, MAX_LOCAL_BRANCH_SUGGESTIONS);
  assert.equal(projection.truncated, true);
  assert.equal(projection.branches.includes("main"), true);
  assert.deepEqual(
    projection.branches,
    [...projection.branches].sort((left, right) => left.localeCompare(right)),
  );
});

test("local branch discovery force-terminates a child that exceeds its deadline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-local-branch-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execFile("git", ["init", "--quiet", directory]);
  const fixture = join(directory, "git-fixture");
  const pidFile = join(directory, "fixture.pid");
  await writeFile(
    fixture,
    `#!/bin/bash
set -eu
printf '%s' "$$" > ${JSON.stringify(pidFile)}
trap '' TERM
while true; do sleep 1; done
`,
  );
  await chmod(fixture, 0o700);

  await assert.rejects(
    repositoryLocalBranchProjection(directory, fixture, 500),
    /did not finish while discovering local branches/,
  );
  const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  assert.throws(() => process.kill(pid, 0));
});

test("default branch remote overflow stops after one bounded Git child", async (t) => {
  const fixture = await configuredRemoteFixture(MAX_DEFAULT_BRANCH_REMOTES + 44, false);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  assert.equal(await repositoryDefaultBranch(fixture.directory, fixture.wrapper), null);
  const calls = (await readFile(fixture.calls, "utf8")).trim().split("\n");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, / remote$/);
});

test("default branch agreement uses constant Git children at the inspection ceiling", async (t) => {
  const fixture = await configuredRemoteFixture(MAX_DEFAULT_BRANCH_REMOTES, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  assert.equal(await repositoryDefaultBranch(fixture.directory, fixture.wrapper), "main");
  const calls = (await readFile(fixture.calls, "utf8")).trim().split("\n");
  assert.equal(calls.length, 3);
  assert.equal(
    calls.some((call) => call.includes(" symbolic-ref ")),
    false,
  );
  assert.equal(calls.filter((call) => call.includes(" for-each-ref ")).length, 1);
});

test("default branch inspection ignores unconfigured stale remote HEADs", async (t) => {
  const fixture = await configuredRemoteFixture(1, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const staleDirectory = join(fixture.directory, ".git", "refs", "remotes", "stale");
  const revision = (
    await execFile("git", ["-C", fixture.directory, "rev-parse", "HEAD"])
  ).stdout.trim();
  await mkdir(staleDirectory, { recursive: true });
  await writeFile(join(staleDirectory, "develop"), `${revision}\n`);
  await writeFile(join(staleDirectory, "HEAD"), "ref: refs/remotes/stale/develop\n");

  assert.equal(await repositoryDefaultBranch(fixture.directory, fixture.wrapper), "main");
});

test("default branch inspection rejects malformed remote HEAD framing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-default-remote-malformed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execFile("git", ["init", "--quiet", directory]);
  const fixture = join(directory, "git-fixture");
  await writeFile(
    fixture,
    `#!/bin/bash
set -eu
if [[ "$*" == *" for-each-ref "* ]]; then
  printf 'origin/HEAD\\0origin/main\\0unexpected\\n'
else
  printf 'origin\\n'
fi
`,
  );
  await chmod(fixture, 0o700);

  await assert.rejects(
    repositoryDefaultBranch(directory, fixture),
    /malformed remote HEAD metadata/,
  );
});

test("default branch inspection force-terminates a child past its deadline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-default-remote-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execFile("git", ["init", "--quiet", directory]);
  const fixture = join(directory, "git-fixture");
  const pidFile = join(directory, "fixture.pid");
  await writeFile(
    fixture,
    `#!/bin/bash
set -eu
printf '%s' "$$" > ${JSON.stringify(pidFile)}
trap '' TERM
while true; do sleep 1; done
`,
  );
  await chmod(fixture, 0o700);

  await assert.rejects(
    repositoryDefaultBranch(directory, fixture, 500),
    /did not finish while inspecting remote defaults/,
  );
  const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  assert.throws(() => process.kill(pid, 0));
});

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
    localBranchCount: 2,
    localBranchesTruncated: false,
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
