import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import { DEFAULT_PREFERENCES, PreferencesStore } from "./preferences.ts";
import { ClaudeProfileStore } from "./profiles.ts";
import { LocalStateStore } from "./state.ts";

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
