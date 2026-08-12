import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import {
  consumeGitBlobBatch,
  deliveryCandidateIdentity,
  prepareReleaseCandidate,
  sourceTreeDigest,
} from "./release-candidate.ts";

const execFileAsync = promisify(execFile);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aldunis-release-candidate-"));
  await execFileAsync("git", ["-C", root, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Aldunis Test"]);
  await execFileAsync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://example.invalid/acme/widget.git",
  ]);
  await mkdir(join(root, "artifact"));
  await writeFile(join(root, "artifact", "payload.txt"), "payload\n");
  await chmod(join(root, "artifact", "payload.txt"), 0o644);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "widget",
        scripts: { build: "node build.mjs", test: "node --test" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "widget",
      lockfileVersion: 3,
      packages: {},
    }),
  );
  await writeFile(
    join(root, "tenkai.toml"),
    [
      "[product]",
      'name = "widget"',
      'version = "1.2.3"',
      "",
      "[deploy]",
      'workdir = "."',
      'install = "true"',
      'health = "true"',
      'inputs = ["artifact"]',
      "",
    ].join("\n"),
  );
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

test("candidate preparation binds committed source, manifest, artifacts, and npm definition", async () => {
  const root = await fixture();
  const candidate = await prepareReleaseCandidate(root, root, "tenkai.toml");
  assert.match(candidate.identity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(candidate.identity, deliveryCandidateIdentity(candidate.document));
  assert.equal(candidate.release, "widget@1.2.3");
  assert.equal(candidate.document.repository.id, "https://example.invalid/acme/widget.git");
  assert.equal(candidate.document.commit.algorithm, "sha1");
  assert.equal(candidate.document.artifacts[0]?.location_class, "local");
  assert.deepEqual(
    candidate.build.commands.map((command) => command.args),
    [["ci", "--ignore-scripts", "--no-audit", "--no-fund"], ["run", "build"], ["test"]],
  );
});

test("artifact identity uses committed executable modes instead of ambient permissions", async () => {
  const root = await fixture();
  const first = await prepareReleaseCandidate(root, root, "tenkai.toml");
  await execFileAsync("git", ["-C", root, "config", "core.filemode", "false"]);
  await chmod(join(root, "artifact"), 0o700);
  await chmod(join(root, "artifact", "payload.txt"), 0o755);

  const second = await prepareReleaseCandidate(root, root, "tenkai.toml");

  assert.equal(second.document.artifacts[0]?.digest, first.document.artifacts[0]?.digest);
  assert.equal(second.identity, first.identity);
});

test("changed source, manifest, artifact, and build definitions invalidate the candidate", async () => {
  const root = await fixture();
  const first = await prepareReleaseCandidate(root, root, "tenkai.toml");
  const cases: Array<[string, string]> = [
    ["artifact/payload.txt", "changed artifact\n"],
    [
      "package.json",
      JSON.stringify({ scripts: { build: "node changed.mjs", test: "node --test" } }),
    ],
    [
      "tenkai.toml",
      '[product]\nname="widget"\nversion="1.2.4"\n[deploy]\ninstall="true"\ninputs=[]\n',
    ],
  ];
  for (const [path, contents] of cases) {
    await writeFile(join(root, path), contents);
    await execFileAsync("git", ["-C", root, "add", path]);
    await execFileAsync("git", ["-C", root, "commit", "-qm", `change ${path}`]);
    const next = await prepareReleaseCandidate(root, root, "tenkai.toml");
    assert.notEqual(next.identity, first.identity);
  }
});

test("dirty and untracked worktrees fail closed", async () => {
  const root = await fixture();
  await writeFile(join(root, "untracked.txt"), "no\n");
  await assert.rejects(
    () => prepareReleaseCandidate(root, root, "tenkai.toml"),
    /tracked and untracked change/,
  );
});

test("ignored manifest and artifact inputs are not treated as committed", async () => {
  const manifestRoot = await fixture();
  await execFileAsync("git", ["-C", manifestRoot, "rm", "-q", "tenkai.toml"]);
  await writeFile(join(manifestRoot, ".gitignore"), "tenkai.toml\n");
  await execFileAsync("git", ["-C", manifestRoot, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", manifestRoot, "commit", "-qm", "ignore manifest"]);
  await writeFile(
    join(manifestRoot, "tenkai.toml"),
    ["[product]", 'name = "widget"', 'version = "1.2.3"', "[deploy]", 'inputs = ["artifact"]'].join(
      "\n",
    ),
  );
  await assert.rejects(
    () => prepareReleaseCandidate(manifestRoot, manifestRoot, "tenkai.toml"),
    /manifest must be tracked/,
  );

  const artifactRoot = await fixture();
  await writeFile(join(artifactRoot, ".gitignore"), "artifact/ignored.txt\n");
  await execFileAsync("git", ["-C", artifactRoot, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", artifactRoot, "commit", "-qm", "ignore artifact input"]);
  await writeFile(join(artifactRoot, "artifact", "ignored.txt"), "not committed\n");
  await assert.rejects(
    () => prepareReleaseCandidate(artifactRoot, artifactRoot, "tenkai.toml"),
    /cannot contain ignored local inputs/,
  );
});

test("the accepted Aldunis candidate conformance vector is reproduced", () => {
  const identity = deliveryCandidateIdentity({
    schema: "aldunis.delivery-candidate/v1",
    repository: { authority: "git", id: "https://example.invalid/acme/widget.git" },
    commit: { algorithm: "sha1", oid: "0123456789abcdef0123456789abcdef01234567" },
    source_tree_digest: `sha256:${"d".repeat(64)}`,
    manifest: { path: "deploy/tenkai.toml", digest: `sha256:${"c".repeat(64)}` },
    artifacts: [
      {
        media_type: "application/vnd.oci.image.manifest.v1+json",
        size: 2,
        digest: `sha256:${"a".repeat(64)}`,
        location_class: "oci",
      },
      {
        media_type: "application/vnd.oci.image.manifest.v1+json",
        size: 10,
        digest: `sha256:${"a".repeat(64)}`,
        location_class: "oci",
      },
    ],
    build_definition_digest: `sha256:${"b".repeat(64)}`,
  });
  assert.equal(identity, "sha256:3059514e30875e7795f4d988295ef3e6d92387b6a8a6f86356e7627cf51745a0");
});

test("the accepted source-tree conformance vector is reproduced", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-source-tree-vector-"));
  await execFileAsync("git", ["-C", root, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Aldunis Test"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "hello\n");
  await writeFile(join(root, "src", "main.ts"), "export {};\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "fixture"]);
  assert.equal(
    await sourceTreeDigest(root),
    "sha256:be3211c0a271b20c678872100d6c693b7d0952bcaa3c9970c92b5b13ac7c73bc",
  );
});

test("source-tree batching preserves regular, executable, Unicode, and empty blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-source-tree-batch-"));
  await execFileAsync("git", ["-C", root, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Aldunis Test"]);
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, "ümlaut.txt"), "Grüße\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "fixture"]);

  assert.equal(
    await sourceTreeDigest(root),
    "sha256:db430f408c900e2735c3750892e97d5e34b3e690fbf2d1db3941a4bf58e82b92",
  );
});

test("Git blob batch parsing streams exact objects across arbitrary chunk boundaries", async () => {
  const firstOid = "1".repeat(40);
  const secondOid = "2".repeat(64);
  const output = Buffer.from(`${firstOid} blob 5\nhello\n${secondOid} blob 0\n\n`);
  const chunks = [
    output.subarray(0, 7),
    output.subarray(7, 48),
    output.subarray(48, 55),
    output.subarray(55),
  ];
  const digests: string[] = [];

  await consumeGitBlobBatch(
    Readable.from(chunks),
    [{ oid: firstOid }, { oid: secondOid }],
    (digest) => digests.push(digest.toString("hex")),
  );

  assert.deepEqual(digests, [sha256("hello"), sha256("")]);
});

test("Git blob batch parsing fails closed on malformed or incomplete framing", async () => {
  const oid = "1".repeat(40);
  const invalid = [
    `${"2".repeat(40)} blob 1\na\n`,
    `${oid} tree 1\na\n`,
    `${oid} blob 9007199254740992\n`,
    `${oid} blob 2\na`,
    `${oid} blob 1\nax`,
    `${oid} blob 1\na\ntrailing`,
  ];
  for (const output of invalid) {
    await assert.rejects(
      () => consumeGitBlobBatch(Readable.from([Buffer.from(output)]), [{ oid }], () => undefined),
      /Git batch/,
    );
  }
});
