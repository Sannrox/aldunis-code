import assert from "node:assert/strict";
import test from "node:test";
import type { ForkPreview } from "../../types";
import { ReviewedForkSessionModule } from "./fork-session";

const preview = (): ForkPreview => ({
  sourceThreadId: "thread-1",
  sourceProvider: "claude-code",
  workspaceMode: "shared",
  worktree: "/repo",
  messages: [{ id: "m1", role: "user", text: "hello", createdAt: "2026-08-13T12:00:00.000Z" }],
  annotations: [],
  files: [],
  summaries: [],
  byteCount: 12,
  digest: "digest-1",
  excluded: ["provider session"],
  contextPackage: {
    pins: [],
    entries: [],
    totalBytes: 0,
    estimatedTokens: 0,
    digest: "pkg-1",
  },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("reviewed fork previews the source thread", async () => {
  const session = new ReviewedForkSessionModule({
    request: async (input, init) => {
      assert.equal(input, "/api/forks/preview");
      assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), { sourceThreadId: "thread-1" });
      return jsonResponse(preview());
    },
  });
  await session.preview("thread-1");
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.preview?.digest, "digest-1");
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.error, null);
});

test("reviewed fork ignores a stale preview after reset", async () => {
  let resolvePreview!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolvePreview = resolve;
  });
  const session = new ReviewedForkSessionModule({
    request: async () => pending,
  });
  const first = session.preview("thread-1");
  session.reset();
  resolvePreview(jsonResponse(preview()));
  await first;
  assert.equal(session.getSnapshot().preview, null);
  assert.equal(session.getSnapshot().busy, true);
});

test("reviewed fork create stamps the current preview digest", async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const session = new ReviewedForkSessionModule({
    request: async (input, init) => {
      calls.push({ route: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      if (String(input) === "/api/forks/preview") return jsonResponse(preview());
      return jsonResponse({ thread: { id: "thread-2" } });
    },
  });
  await session.preview("thread-1");
  const threadId = await session.create({
    sourceThreadId: "thread-1",
    provider: "codex-cli",
    profileId: null,
    model: "gpt-5.4",
    worktree: "/repo/.aldunis/fork",
    workspaceMode: "aldunis-managed",
  });
  assert.equal(threadId, "thread-2");
  assert.deepEqual(calls[1]?.body, {
    sourceThreadId: "thread-1",
    provider: "codex-cli",
    profileId: null,
    model: "gpt-5.4",
    expectedDigest: "digest-1",
    worktree: "/repo/.aldunis/fork",
    workspaceMode: "aldunis-managed",
  });
});

test("reviewed fork create requires a matching preview source", async () => {
  const session = new ReviewedForkSessionModule({
    request: async (input) => {
      if (String(input) === "/api/forks/preview") return jsonResponse(preview());
      throw new Error("create should not run");
    },
  });
  await session.preview("thread-1");
  const threadId = await session.create({
    sourceThreadId: "thread-2",
    provider: "codex-cli",
    profileId: null,
    model: "gpt-5.4",
    workspaceMode: "shared",
  });
  assert.equal(threadId, null);
  assert.equal(session.getSnapshot().preview?.digest, "digest-1");
  assert.equal(session.getSnapshot().busy, false);
});

test("reviewed fork create requires a preview", async () => {
  let called = false;
  const session = new ReviewedForkSessionModule({
    request: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  const threadId = await session.create({
    sourceThreadId: "thread-1",
    provider: "codex-cli",
    profileId: null,
    model: "gpt-5.4",
    workspaceMode: "shared",
  });
  assert.equal(threadId, null);
  assert.equal(called, false);
});

test("reviewed fork keeps the fallback when preview error JSON is malformed", async () => {
  const session = new ReviewedForkSessionModule({
    request: async () => jsonResponse(null, 500),
  });
  await session.preview("thread-1");
  assert.equal(session.getSnapshot().error, "The fork preview could not be prepared.");
  assert.equal(session.getSnapshot().busy, false);
});

test("reviewed fork keeps the fallback when create error JSON is malformed", async () => {
  const session = new ReviewedForkSessionModule({
    request: async (input) => {
      if (String(input) === "/api/forks/preview") return jsonResponse(preview());
      return jsonResponse(null, 500);
    },
  });
  await session.preview("thread-1");
  const threadId = await session.create({
    sourceThreadId: "thread-1",
    provider: "codex-cli",
    profileId: null,
    model: "gpt-5.4",
    workspaceMode: "shared",
  });
  assert.equal(threadId, null);
  assert.equal(session.getSnapshot().error, "The fork could not be created.");
  assert.equal(session.getSnapshot().busy, false);
});

test("reviewed fork ignores a stale create after reset", async () => {
  let resolveCreate!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  const session = new ReviewedForkSessionModule({
    request: async (input) => {
      if (String(input) === "/api/forks/preview") return jsonResponse(preview());
      return pending;
    },
  });
  await session.preview("thread-1");
  const first = session.create({
    sourceThreadId: "thread-1",
    provider: "codex-cli",
    profileId: null,
    model: "gpt-5.4",
    workspaceMode: "shared",
  });
  session.reset();
  resolveCreate(jsonResponse({ thread: { id: "thread-stale" } }));
  assert.equal(await first, null);
  assert.equal(session.getSnapshot().preview, null);
});
