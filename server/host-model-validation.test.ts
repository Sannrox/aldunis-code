import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
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
  const repository = await mkdtemp(join(tmpdir(), "aldunis-model-boundary-repo-"));
  const directory = await mkdtemp(join(tmpdir(), "aldunis-model-boundary-state-"));
  await execFileAsync("git", ["-C", repository, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Aldunis Test"]);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", repository, "add", "."]);
  await execFileAsync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  const canonicalRepository = await realpath(repository);
  const state = new LocalStateStore(directory);
  await state.saveProject({ id: "project-1", name: "Fixture", root: canonicalRepository });
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
    repository: canonicalRepository,
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

for (const remote of [false, true]) {
  test(`stale run models fail before state mutation for ${remote ? "remote" : "loopback"} requests`, async () => {
    const current = await fixture(remote);
    try {
      const response = await post(current.url, "/api/provider/runs", {
        root: current.repository,
        worktree: current.repository,
        prompt: "run with stale model",
        conversationId: "conversation-1",
        projectId: "project-1",
        mode: "build",
        provider: "claude-code",
        profileId: "missing-profile",
        model: "stale-model",
      });
      assert.equal(response.status, 409);
      const body = await response.json() as { error?: string };
      assert.match(body.error ?? "", /Refresh provider discovery and retry/);
      assert.equal((await current.state.load()).threads.length, 0);
    } finally {
      await close(current.server);
    }
  });
}

test("fork validation stores the resolved provider default", async () => {
  const current = await fixture();
  try {
    const source = await current.state.startTurn({
      projectId: "project-1",
      worktree: current.repository,
      prompt: "source",
      mode: "build",
      provider: "codex-cli",
      model: "gpt-5",
    });
    const previewResponse = await post(current.url, "/api/forks/preview", {
      sourceThreadId: source.thread.id,
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { digest: string };
    const response = await post(current.url, "/api/forks/create", {
      sourceThreadId: source.thread.id,
      provider: "claude-code",
      profileId: "default:claude-code",
      model: "default",
      expectedDigest: preview.digest,
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { thread: { model?: string | null }; fork: { model: string } };
    assert.equal(body.thread.model, "default");
    assert.equal(body.fork.model, "default");
  } finally {
    await close(current.server);
  }
});
