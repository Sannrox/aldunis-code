import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  DeliveryBroker,
  inspectDelivery,
  MAX_DELIVERY_CHANGED_PATHS,
  pullRequestDraft,
  sanitizeDiagnostic,
} from "./delivery.ts";

const execFileAsync = promisify(execFile);

async function fixture(detached = false) {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-delivery-"));
  const remote = await mkdtemp(join(tmpdir(), "aldunis-code-remote-"));
  const git = (...args: string[]) => execFileAsync("git", ["-C", root, ...args]);
  await execFileAsync("git", ["init", "--bare", "-q", remote]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Aldunis Test");
  await writeFile(join(root, "reviewed.txt"), "before\n");
  await writeFile(join(root, "unrelated.txt"), "before\n");
  await git("add", ".");
  await git("commit", "-qm", "fixture");
  await git("remote", "add", "upstream", remote);
  await git("switch", "-qc", "codex/reviewed-delivery");
  if (detached) await git("checkout", "-q", "--detach");
  await writeFile(join(root, "reviewed.txt"), "after\n");
  await writeFile(join(root, "unrelated.txt"), "user work\n");
  return { root, git };
}

test("inspection exposes branch, remote, upstream, and staged state without mutation", async () => {
  const { root } = await fixture();
  const context = await inspectDelivery(root, root);
  assert.equal(context.branch, "codex/reviewed-delivery");
  assert.equal(context.detached, false);
  assert.deepEqual(context.staged, []);
  assert.deepEqual(context.unstaged, ["reviewed.txt", "unrelated.txt"]);
  assert.equal(context.remotes[0]?.name, "upstream");
  assert.equal(context.changedCount, 2);
  assert.equal(context.truncated, false);
});

test("delivery inspection streams an exact bounded projection beyond one MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-large-delivery-"));
  try {
    await execFileAsync("git", ["init", "-q", "-b", "codex/large-delivery", root]);
    const empty = join(root, "empty");
    await writeFile(empty, "");
    const blob = await execFileAsync("git", ["-C", root, "hash-object", "-w", "empty"]);
    await rm(empty);
    const update = spawn("git", ["-C", root, "update-index", "--index-info"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    update.stderr.setEncoding("utf8");
    update.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    for (let index = 0; index < 90_000; index += 1) {
      const record = `100644 ${blob.stdout.trim()}\tf/${index.toString().padStart(6, "0")}\n`;
      if (!update.stdin.write(record)) {
        await new Promise<void>((resolve) => update.stdin.once("drain", resolve));
      }
    }
    update.stdin.end();
    const updateCode = await new Promise<number | null>((resolve, reject) => {
      update.once("error", reject);
      update.once("close", resolve);
    });
    assert.equal(updateCode, 0, stderr);
    const tree = await execFileAsync("git", ["-C", root, "write-tree"]);
    const commit = await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      tree.stdout.trim(),
      "-m",
      "large delivery fixture",
    ]);
    await execFileAsync("git", ["-C", root, "update-ref", "HEAD", commit.stdout.trim()]);

    const context = await inspectDelivery(root, root);
    assert.equal(context.stagedCount, 0);
    assert.equal(context.unstagedCount, 90_000);
    assert.equal(context.changedCount, 90_000);
    assert.equal(context.unstaged.length, MAX_DELIVERY_CHANGED_PATHS);
    assert.equal(context.truncated, true);
    assert.deepEqual(context.unstaged.slice(0, 2), ["f/000000", "f/000001"]);
    const draft = pullRequestDraft(context, "main");
    assert.equal(draft.changedFiles.length, 40);
    assert.equal(draft.omittedFiles, 89_960);
    assert.match(draft.body, /Changed paths: 90000/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pull-request drafts use only bounded branch and changed-path metadata", async () => {
  const { root } = await fixture();
  const draft = pullRequestDraft(await inspectDelivery(root, root), "main");
  assert.equal(draft.title, "Update Reviewed Delivery");
  assert.equal(draft.base, "main");
  assert.deepEqual(draft.changedFiles, ["reviewed.txt", "unrelated.txt"]);
  assert.match(draft.body, /reviewed\.txt/);
  assert.match(draft.body, /unrelated\.txt/);
  assert.doesNotMatch(draft.body, /user work|after/);
  assert.equal(draft.omittedFiles, 0);
});

test("pull-request drafts reject detached branches and invalid bases", async () => {
  const { root } = await fixture(true);
  const context = await inspectDelivery(root, root);
  assert.throws(() => pullRequestDraft(context, "main"), /Detached HEAD/);
  assert.throws(
    () => pullRequestDraft({ ...context, branch: "codex/example" }, ""),
    /base branch is required/,
  );
});

test("stage plans preserve unrelated changes and approvals are single-use", async () => {
  const { root, git } = await fixture();
  const broker = new DeliveryBroker();
  const plan = await broker.plan(root, root, "stage", { paths: ["reviewed.txt"] });
  assert.match(plan.summary, /1 selected file/);
  await broker.execute(plan.id, root, root);
  const status = (await git("status", "--porcelain=v1")).stdout;
  assert.match(status, /^M {2}reviewed\.txt$/m);
  assert.match(status, /^ M unrelated\.txt$/m);
  await assert.rejects(() => broker.execute(plan.id, root, root), /does not exist/);
});

test("concurrent execution consumes a plan before asynchronous validation", async () => {
  const { root } = await fixture();
  const broker = new DeliveryBroker();
  const plan = await broker.plan(root, root, "stage", { paths: ["reviewed.txt"] });
  const results = await Promise.allSettled([
    broker.execute(plan.id, root, root),
    broker.execute(plan.id, root, root),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("delivery broker evicts the oldest abandoned preview at capacity", async () => {
  const { root } = await fixture();
  const broker = new DeliveryBroker(1);
  const oldest = await broker.plan(root, root, "stage", { paths: ["reviewed.txt"] });
  const newest = await broker.plan(root, root, "stage", { paths: ["unrelated.txt"] });

  assert.equal(broker.retainedPlanCount, 1);
  await assert.rejects(() => broker.execute(oldest.id, root, root), /does not exist/);
  await broker.execute(newest.id, root, root);
});

test("stage plans include both sides of a rename", async () => {
  const { root, git } = await fixture();
  await rename(join(root, "reviewed.txt"), join(root, "renamed.txt"));
  const broker = new DeliveryBroker();
  const plan = await broker.plan(root, root, "stage", { paths: ["renamed.txt", "reviewed.txt"] });
  await broker.execute(plan.id, root, root);
  const staged = (await git("diff", "--cached", "--name-status", "-M")).stdout;
  assert.match(staged, /^(?:R\d*\treviewed\.txt\t|A\t)renamed\.txt$/m);
  assert.match(staged, /^(?:R\d*\t)?reviewed\.txt(?:\trenamed\.txt)?$|^D\treviewed\.txt$/m);
});

test("stage plans preserve whitespace in valid Git paths", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, " spaced.txt "), "reviewed\n");
  const broker = new DeliveryBroker();
  const plan = await broker.plan(root, root, "stage", { paths: [" spaced.txt "] });
  await broker.execute(plan.id, root, root);
  assert.match((await git("diff", "--cached", "--name-only")).stdout, / spaced\.txt /);
});

test("stage plans treat Git pathspec magic as a literal filename", async () => {
  const { root, git } = await fixture();
  await writeFile(join(root, ":(glob)**"), "reviewed\n");
  const broker = new DeliveryBroker();
  const plan = await broker.plan(root, root, "stage", { paths: [":(glob)**"] });
  await broker.execute(plan.id, root, root);
  const status = (await git("status", "--porcelain=v1")).stdout;
  assert.match(status, /^A {2}:\(glob\)\*\*$/m);
  assert.match(status, /^ M reviewed\.txt$/m);
  assert.match(status, /^ M unrelated\.txt$/m);
});

test("commit plans require staged changes and execute the reviewed message", async () => {
  const { root, git } = await fixture();
  const broker = new DeliveryBroker();
  await assert.rejects(
    () => broker.plan(root, root, "commit", { message: "reviewed" }),
    /Stage reviewed/,
  );
  await git("add", "--", "reviewed.txt");
  const plan = await broker.plan(root, root, "commit", { message: "feat: reviewed delivery" });
  await broker.execute(plan.id, root, root);
  assert.equal((await git("log", "-1", "--pretty=%s")).stdout.trim(), "feat: reviewed delivery");
  assert.match((await git("status", "--porcelain=v1")).stdout, /unrelated\.txt/);
});

test("commit preview rejects a staged inventory beyond the review projection", async () => {
  const { root, git } = await fixture();
  const paths = Array.from(
    { length: MAX_DELIVERY_CHANGED_PATHS + 1 },
    (_, index) => `staged-${index.toString().padStart(3, "0")}.txt`,
  );
  await Promise.all(paths.map((path) => writeFile(join(root, path), "reviewed\n")));
  await git("add", "--", ...paths);
  await assert.rejects(
    () => new DeliveryBroker().plan(root, root, "commit", { message: "reviewed" }),
    /limited to 256 staged files/,
  );
});

test("commit plans reject files with staged and unstaged edits", async () => {
  const { root, git } = await fixture();
  const broker = new DeliveryBroker();
  await git("add", "--", "reviewed.txt");
  await writeFile(join(root, "reviewed.txt"), "changed again after staging\n");
  await Promise.all(
    Array.from({ length: MAX_DELIVERY_CHANGED_PATHS + 1 }, (_, index) =>
      writeFile(join(root, `a-${index.toString().padStart(3, "0")}.txt`), "unrelated\n"),
    ),
  );
  const context = await inspectDelivery(root, root);
  assert.equal(context.truncated, true);
  assert.equal(context.unstaged.includes("reviewed.txt"), false);
  await assert.rejects(
    () => broker.plan(root, root, "commit", { message: "not the reviewed snapshot" }),
    /without additional unstaged edits/,
  );
});

test("detached HEAD and protected branch mutations fail explicitly", async () => {
  const detached = await fixture(true);
  await assert.rejects(
    () =>
      new DeliveryBroker().plan(detached.root, detached.root, "stage", { paths: ["reviewed.txt"] }),
    /Detached HEAD/,
  );
  const protectedFixture = await fixture();
  await protectedFixture.git("switch", "-q", "main");
  await protectedFixture.git("add", "--", "reviewed.txt");
  await assert.rejects(
    () =>
      new DeliveryBroker().plan(protectedFixture.root, protectedFixture.root, "commit", {
        message: "no",
      }),
    /protected branch/,
  );
});

test("push plans show non-origin destinations and never add force flags", async () => {
  const { root } = await fixture();
  const plan = await new DeliveryBroker().plan(root, root, "push", { remote: "upstream" });
  assert.equal(plan.remote, "upstream");
  assert.ok(plan.destination);
  assert.equal(plan.details.includes("force: disabled"), true);
  assert.equal(
    plan.details.some((detail) => detail.includes("--force")),
    false,
  );
});

test("displayed remotes omit URL credentials, query strings, and fragments", async () => {
  const { root, git } = await fixture();
  await git(
    "remote",
    "set-url",
    "--push",
    "upstream",
    "ssh://user:password@example.invalid/org/repo.git?token=secret#fragment",
  );
  const context = await inspectDelivery(root, root);
  assert.equal(context.remotes[0]?.url, "ssh://example.invalid/org/repo");
});

test("Git diagnostics redact remote credentials and token-shaped values", () => {
  const diagnostic = sanitizeDiagnostic(
    "fatal: Authentication failed for https://user:password@example.invalid/org/repo.git?token=secret#fragment token=ghp_example",
  );
  assert.equal(diagnostic.includes("password"), false);
  assert.equal(diagnostic.includes("secret"), false);
  assert.equal(diagnostic.includes("ghp_example"), false);
  assert.match(diagnostic, /https:\/\/example\.invalid\/org\/repo/);
});

test("pull request plans reject GitHub lookalike hosts", async () => {
  const { root, git } = await fixture();
  await git("remote", "set-url", "--push", "upstream", "https://evilgithub.com/org/repo.git");
  await assert.rejects(
    () =>
      new DeliveryBroker().plan(root, root, "pull_request", {
        remote: "upstream",
        base: "main",
        title: "Reviewed",
        body: "Reviewed body",
      }),
    /requires a GitHub remote/,
  );
});

test("execution rejects changed file content, index state, HEAD, and remote destinations", async () => {
  const stageFixture = await fixture();
  const stageBroker = new DeliveryBroker();
  const stage = await stageBroker.plan(stageFixture.root, stageFixture.root, "stage", {
    paths: ["reviewed.txt"],
  });
  await writeFile(join(stageFixture.root, "reviewed.txt"), "changed after review\n");
  await assert.rejects(
    () => stageBroker.execute(stage.id, stageFixture.root, stageFixture.root),
    /state or destination changed/,
  );

  const commitFixture = await fixture();
  await commitFixture.git("add", "--", "reviewed.txt");
  const commitBroker = new DeliveryBroker();
  const commit = await commitBroker.plan(commitFixture.root, commitFixture.root, "commit", {
    message: "reviewed",
  });
  await commitFixture.git("add", "--", "unrelated.txt");
  await assert.rejects(
    () => commitBroker.execute(commit.id, commitFixture.root, commitFixture.root),
    /state or destination changed/,
  );

  const remoteFixture = await fixture();
  const pushBroker = new DeliveryBroker();
  const push = await pushBroker.plan(remoteFixture.root, remoteFixture.root, "push", {
    remote: "upstream",
  });
  await remoteFixture.git(
    "remote",
    "set-url",
    "--push",
    "upstream",
    "https://example.invalid/redirect.git",
  );
  await assert.rejects(
    () => pushBroker.execute(push.id, remoteFixture.root, remoteFixture.root),
    /state or destination changed/,
  );
});
