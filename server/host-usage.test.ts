import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import { LocalStateStore } from "./state.ts";

test("usage summary exposes only the requested local receipt range", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-usage-host-"));
  const state = new LocalStateStore(directory);
  const server = createLocalHost(directory, state);
  try {
    await state.saveProject({ id: "project-1", name: "Fixture", root: "/fixture" });
    const { thread, turn } = await state.startTurn({
      projectId: "project-1",
      worktree: "/fixture",
      prompt: "Collect bounded usage",
      mode: "ask",
      provider: "codex-cli",
      model: "gpt-5-codex",
    });
    await state.recordProviderEvent(thread.id, turn.id, "codex-cli", {
      kind: "context_usage",
      usedTokens: 900,
      maxTokens: 200_000,
      inputTokens: 800,
      outputTokens: 100,
      cachedInputTokens: 50,
    });
    await state.recordProviderEvent(thread.id, turn.id, "codex-cli", {
      kind: "turn_completed",
      sessionId: "session-1",
      costUsd: 0.02,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/usage/summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rangeDays: 7 }),
    });
    assert.equal(response.status, 200);
    const report = (await response.json()) as {
      rangeDays: number;
      totals: {
        observedTurns: number;
        completedTurns: number;
        inputTokens: number;
        outputTokens: number;
        processedTokens: number;
        cachedInputTokens: number;
        cacheWriteInputTokens: number;
        reasoningOutputTokens: number;
        reportedCostUsd: number | null;
        pricedTurns: number;
      };
    };
    assert.equal(report.rangeDays, 7);
    assert.deepEqual(report.totals, {
      observedTurns: 1,
      completedTurns: 1,
      inputTokens: 800,
      outputTokens: 100,
      processedTokens: 900,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      reportedCostUsd: 0.02,
      pricedTurns: 1,
    });

    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/usage/summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rangeDays: 8 }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { recursive: true, force: true });
  }
});
