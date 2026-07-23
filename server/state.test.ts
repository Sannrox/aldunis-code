import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStateError, LocalStateStore } from "./state.ts";

async function fixtureStore(): Promise<{ directory: string; store: LocalStateStore }> {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-state-"));
  return { directory, store: new LocalStateStore(directory) };
}

test("versioned projects, threads, turns, messages, activities, and sessions rebuild deterministically", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Inspect the change",
    mode: "plan",
  });
  await store.recordProviderEvent(thread.id, turn.id, {
    kind: "session_started",
    sessionId: "session-1",
    model: "sonnet",
  });
  await store.recordProviderEvent(thread.id, turn.id, {
    kind: "assistant_text",
    text: "The change is safe.",
  });
  await store.recordProviderEvent(thread.id, turn.id, {
    kind: "tool_started",
    toolCallId: "tool-1",
    name: "Read",
  });
  await store.recordProviderEvent(thread.id, turn.id, {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: 0.01,
  });

  const first = await store.load();
  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt, first);
  assert.equal(rebuilt.schemaVersion, 1);
  assert.equal(rebuilt.projects[0].schemaVersion, 1);
  assert.equal(rebuilt.threads[0].schemaVersion, 1);
  assert.equal(rebuilt.turns[0].status, "completed");
  assert.equal(rebuilt.turns[0].mode, "plan");
  assert.deepEqual(rebuilt.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(rebuilt.activities[0].name, "Read");
  assert.equal(rebuilt.providerSessions[0].sessionId, "session-1");
});

test("concurrent writes remain strictly ordered and crash-safe", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: `Turn ${index}`,
    mode: "ask",
  })));

  const projection = await new LocalStateStore(directory).load();
  const contents = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  const sequences = contents.trim().split("\n").map((line) => JSON.parse(line).sequence);
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  assert.equal(projection.threads.length, 12);
  assert.equal(projection.turns.length, 12);
  assert.equal(projection.messages.length, 12);
});

test("corruption and incompatible schemas fail visibly without discarding history", async () => {
  const corrupt = await fixtureStore();
  await writeFile(join(corrupt.directory, "events.v1.jsonl"), "{\"schemaVersion\":1", "utf8");
  await assert.rejects(
    () => new LocalStateStore(corrupt.directory).load(),
    (error: unknown) => error instanceof LocalStateError && /corrupt at line 1/.test(error.message),
  );

  const incompatible = await fixtureStore();
  await writeFile(
    join(incompatible.directory, "events.v1.jsonl"),
    `${JSON.stringify({ schemaVersion: 2, sequence: 1, id: "event", recordedAt: "now", event: {} })}\n`,
    "utf8",
  );
  await assert.rejects(
    () => new LocalStateStore(incompatible.directory).load(),
    (error: unknown) => error instanceof LocalStateError && /incompatible schema/.test(error.message),
  );
});

test("project deletion and retention physically remove sensitive conversation data", async () => {
  const deleted = await fixtureStore();
  await deleted.store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await deleted.store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "secret prompt sentinel",
    mode: "build",
  });
  await deleted.store.deleteProject("project-1");
  assert.deepEqual(await deleted.store.load(), {
    schemaVersion: 1,
    sequence: 0,
    projects: [],
    threads: [],
    turns: [],
    messages: [],
    activities: [],
    providerSessions: [],
  });
  assert.equal((await readFile(join(deleted.directory, "events.v1.jsonl"), "utf8")).includes("sentinel"), false);

  const retained = await fixtureStore();
  await retained.store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await retained.store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "expired sensitive prompt",
    mode: "build",
  });
  await retained.store.enforceRetention(new Date(Date.now() + 60_000));
  const projection = await retained.store.load();
  assert.equal(projection.projects.length, 1);
  assert.equal(projection.threads.length, 0);
  assert.equal((await readFile(join(retained.directory, "events.v1.jsonl"), "utf8")).includes("sensitive"), false);
});

test("only allowlisted provider fields are persisted", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "safe prompt",
    mode: "ask",
  });
  await store.recordProviderEvent(thread.id, turn.id, {
    kind: "tool_started",
    toolCallId: "tool-1",
    name: "Read",
  });
  await store.recordProviderEvent(thread.id, turn.id, {
    kind: "failed",
    message: "credential=raw-secret-value",
  });
  const contents = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  assert.equal(contents.includes("process.env"), false);
  assert.equal(contents.includes("credential"), false);
  assert.equal(contents.includes("raw-secret-value"), false);
});
