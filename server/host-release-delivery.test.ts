import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLocalHost } from "./host.ts";
import { ClaudeProfileStore } from "./profiles.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { LocalStateStore } from "./state.ts";

const execFileAsync = promisify(execFile);

async function fixture(remote = false) {
  const repository = await mkdtemp(join(tmpdir(), "aldunis-host-release-repo-"));
  const directory = await mkdtemp(join(tmpdir(), "aldunis-host-release-state-"));
  await execFileAsync("git", ["-C", repository, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Aldunis Test"]);
  await execFileAsync("git", [
    "-C",
    repository,
    "remote",
    "add",
    "origin",
    "https://example.invalid/acme/widget.git",
  ]);
  await mkdir(join(repository, "artifact"));
  await writeFile(join(repository, "artifact", "payload.txt"), "payload\n");
  await writeFile(join(repository, "package.json"), JSON.stringify({
    name: "widget",
    scripts: {
      build: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
    },
  }));
  await writeFile(join(repository, "package-lock.json"), JSON.stringify({
    name: "widget",
    lockfileVersion: 3,
    packages: {},
  }));
  await writeFile(join(repository, "tenkai.toml"), [
    "[product]",
    'name = "widget"',
    'version = "1.2.3"',
    "[deploy]",
    'install = "true"',
    'inputs = ["artifact"]',
  ].join("\n"));
  await execFileAsync("git", ["-C", repository, "add", "."]);
  await execFileAsync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  const state = new LocalStateStore(directory);
  await state.saveProject({
    id: "project-1",
    name: "Widget",
    root: repository,
    chiseiNamespace: "team/widget",
  });
  const remoteAuth = remote
    ? { verify: async () => ({}) } as unknown as RemoteAuth
    : undefined;
  const server = createLocalHost(
    directory,
    state,
    new ClaudeProfileStore(directory),
    remoteAuth,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    directory,
    repository,
    server,
    state,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function post(url: string, route: string, body: unknown) {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function close(server: ReturnType<typeof createLocalHost>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("loopback routes preview, execute, and resume a clean candidate without exposing host secrets", async () => {
  const current = await fixture();
  try {
    const context = {
      projectId: "project-1",
      root: current.repository,
      worktree: current.repository,
    };
    const previewResponse = await post(current.url, "/api/release-delivery/plans", {
      ...context,
      action: "prepare",
      input: { manifestPath: "tenkai.toml" },
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { id: string; details: string[] };
    assert.match(preview.details.join("\n"), /candidate: sha256:/);
    const executed = await post(
      current.url,
      `/api/release-delivery/plans/${preview.id}/execute`,
      context,
    );
    assert.equal(executed.status, 200);
    assert.equal((await executed.json() as { state: string }).state, "candidate_ready");

    const inspection = await post(current.url, "/api/release-delivery/inspect", context);
    assert.equal(inspection.status, 200);
    const serialized = JSON.stringify(await inspection.json());
    assert.doesNotMatch(serialized, /ALDUNIS_CHISEI_TOKEN|TENKAI_DATABASE|package-lock/);
    assert.doesNotMatch(serialized, new RegExp(current.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await close(current.server);
  }
});

test("remote clients cannot invoke or inspect local release delivery", async () => {
  const current = await fixture(true);
  try {
    const response = await post(current.url, "/api/release-delivery/inspect", {
      projectId: "project-1",
      root: current.repository,
      worktree: current.repository,
    });
    assert.equal(response.status, 403);
  } finally {
    await close(current.server);
  }
});

test("release routes reject a sibling worktree's project binding", async () => {
  const current = await fixture();
  const parent = await mkdtemp(join(tmpdir(), "aldunis-host-release-sibling-"));
  const sibling = join(parent, "worktree");
  try {
    await execFileAsync("git", [
      "-C",
      current.repository,
      "worktree",
      "add",
      "-q",
      "-b",
      "sibling-release-test",
      sibling,
      "HEAD",
    ]);
    await current.state.saveProject({
      id: "project-2",
      name: "Widget sibling",
      root: sibling,
      chiseiNamespace: "team/sibling",
    });
    const wrongContext = {
      projectId: "project-1",
      root: current.repository,
      worktree: sibling,
    };
    const inspection = await post(current.url, "/api/release-delivery/inspect", wrongContext);
    assert.equal(inspection.status, 404);
    const wrongPreview = await post(current.url, "/api/release-delivery/plans", {
      ...wrongContext,
      action: "prepare",
      input: { manifestPath: "tenkai.toml" },
    });
    assert.equal(wrongPreview.status, 404);

    const correctContext = { ...wrongContext, projectId: "project-2" };
    const previewResponse = await post(current.url, "/api/release-delivery/plans", {
      ...correctContext,
      action: "prepare",
      input: { manifestPath: "tenkai.toml" },
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { id: string };
    const wrongExecution = await post(
      current.url,
      `/api/release-delivery/plans/${preview.id}/execute`,
      wrongContext,
    );
    assert.equal(wrongExecution.status, 404);
    const execution = await post(
      current.url,
      `/api/release-delivery/plans/${preview.id}/execute`,
      correctContext,
    );
    assert.equal(execution.status, 200);
    const session = await execution.json() as { id: string };
    const wrongReceipt = await post(current.url, "/api/release-delivery/receipt", {
      ...wrongContext,
      sessionId: session.id,
    });
    assert.equal(wrongReceipt.status, 404);
  } finally {
    await close(current.server);
  }
});
