import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLocalHost } from "./host.ts";
import { DEFAULT_PREFERENCES, PreferencesStore } from "./preferences.ts";
import { ClaudeProfileStore } from "./profiles.ts";
import { canonicalizeRepositoryRoot } from "./repository.ts";
import { LocalStateStore } from "./state.ts";

const execFileAsync = promisify(execFile);

test("host linking rejects direct and longer delegated cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-delegated-relationships-"));
  const state = new LocalStateStore(directory);
  const server = createLocalHost(
    directory,
    state,
    new ClaudeProfileStore(directory),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    await fetch(`${url}/api/state/load`, { method: "POST" });
    await state.saveProject({ id: "project", name: "Project", root: directory });
    const createConversation = async (name: string) => (await state.startTurn({
      projectId: "project",
      worktree: join(directory, name),
      prompt: name,
      mode: "ask",
      provider: "codex-cli",
    })).thread;
    const first = await createConversation("first");
    const second = await createConversation("second");
    const third = await createConversation("third");
    await new PreferencesStore(directory).save({
      ...DEFAULT_PREFERENCES,
      orchestrationThreadsBeta: true,
    });
    const link = (parentThreadId: string, childThreadId: string) => fetch(
      `${url}/api/state/delegated-conversations/link`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentThreadId, childThreadId }),
      },
    );

    assert.equal((await link(first.id, second.id)).status, 200);
    const directCycle = await link(second.id, first.id);
    assert.equal(directCycle.status, 409);
    assert.deepEqual(await directCycle.json(), {
      error: "This delegated relationship would create a cycle.",
    });

    assert.equal((await link(second.id, third.id)).status, 200);
    const longCycle = await link(third.id, first.id);
    assert.equal(longCycle.status, 409);
    assert.deepEqual(await longCycle.json(), {
      error: "This delegated relationship would create a cycle.",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("host requires delegated Build children to use available managed worktrees", async () => {
  const repository = await mkdtemp(join(tmpdir(), "aldunis-delegated-build-repo-"));
  const directory = await mkdtemp(join(tmpdir(), "aldunis-delegated-build-state-"));
  const userWorktree = await mkdtemp(join(tmpdir(), "aldunis-delegated-build-user-worktree-"));
  await execFileAsync("git", ["-C", repository, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Aldunis Test"]);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  await execFileAsync("git", ["-C", repository, "worktree", "add", "-q", "-b", "user/child", userWorktree, "HEAD"]);
  const canonicalRepository = await canonicalizeRepositoryRoot(repository);

  const state = new LocalStateStore(directory);
  await state.saveProject({ id: "project", name: "Project", root: canonicalRepository });
  const parent = await state.startTurn({
    projectId: "project",
    worktree: canonicalRepository,
    prompt: "Coordinate",
    mode: "ask",
    provider: "codex-cli",
  });
  await new PreferencesStore(directory).save({
    ...DEFAULT_PREFERENCES,
    orchestrationThreadsBeta: true,
  });
  const server = createLocalHost(
    directory,
    state,
    new ClaudeProfileStore(directory),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const request = (worktree: string, conversationId: string) => fetch(
      `http://127.0.0.1:${address.port}/api/provider/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository,
          worktree,
          prompt: "Make a change",
          conversationId,
          projectId: "project",
          parentThreadId: parent.thread.id,
          mode: "build",
          provider: "codex-cli",
          model: "default",
          contextPins: [],
        }),
      },
    );
    const response = await request(repository, "child-conversation");
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "A Build child requires an isolated worktree. Start it from a managed child worktree or use Ask/Plan for the parent worktree.",
    });
    const userResponse = await request(userWorktree, "user-child-conversation");
    assert.equal(userResponse.status, 409);
    assert.deepEqual(await userResponse.json(), {
      error: "A Build child requires an available Aldunis-managed worktree. Create one through the worktree approval flow.",
    });
    const providerResponse = await fetch(`http://127.0.0.1:${address.port}/api/provider/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository,
        worktree: repository,
        prompt: "Use another provider",
        conversationId: "provider-child-conversation",
        projectId: "project",
        parentThreadId: parent.thread.id,
        mode: "ask",
        provider: "shikigami",
        model: "default",
        contextPins: [],
      }),
    });
    assert.equal(providerResponse.status, 409);
    assert.deepEqual(await providerResponse.json(), {
      error: "A delegated child must use the parent conversation's provider.",
    });
    assert.equal((await state.load()).threads.some((thread) => thread.id === "child-conversation"), false);
    assert.equal((await state.load()).threads.some((thread) => thread.id === "user-child-conversation"), false);
    assert.equal((await state.load()).threads.some((thread) => thread.id === "provider-child-conversation"), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
