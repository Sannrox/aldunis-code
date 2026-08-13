import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceRewindSessionModule } from "./workspace-rewind-session";

const previewBody = () => ({
  currentIdentity: "head-1",
  currentIndexIdentity: "index-1",
  files: [
    {
      path: "src/a.ts",
      state: "modified",
      previousPath: null,
      additions: 1,
      deletions: 0,
    },
  ],
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("workspace rewind previews the checkpoint", async () => {
  const session = new WorkspaceRewindSessionModule({
    request: async (input, init) => {
      assert.equal(input, "/api/checkpoints/cp-1/preview");
      assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
        root: "/repo",
        worktree: "/repo",
      });
      return jsonResponse(previewBody());
    },
  });
  await session.preview("cp-1", "/repo", "/repo");
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.preview?.currentIdentity, "head-1");
  assert.equal(snapshot.preview?.files.length, 1);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.error, null);
});

test("workspace rewind ignores a stale preview after reset", async () => {
  let resolvePreview!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolvePreview = resolve;
  });
  const session = new WorkspaceRewindSessionModule({
    request: async () => pending,
  });
  const first = session.preview("cp-1", "/repo", "/repo");
  session.reset();
  resolvePreview(jsonResponse(previewBody()));
  await first;
  assert.equal(session.getSnapshot().preview, null);
  assert.equal(session.getSnapshot().busy, false);
});

test("workspace rewind confirm stamps preview identities", async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const session = new WorkspaceRewindSessionModule({
    request: async (input, init) => {
      calls.push({ route: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      if (String(input).endsWith("/preview")) return jsonResponse(previewBody());
      return jsonResponse({});
    },
  });
  await session.preview("cp-1", "/repo", "/repo");
  const ok = await session.confirm("cp-1", "/repo", "/repo");
  assert.equal(ok, true);
  assert.deepEqual(calls[1], {
    route: "/api/checkpoints/cp-1/rewind",
    body: {
      root: "/repo",
      worktree: "/repo",
      currentIdentity: "head-1",
      currentIndexIdentity: "index-1",
      confirm: true,
    },
  });
  assert.equal(session.getSnapshot().preview, null);
  assert.equal(session.getSnapshot().busy, false);
});

test("workspace rewind confirm requires a matching preview target", async () => {
  const session = new WorkspaceRewindSessionModule({
    request: async (input) => {
      if (String(input).endsWith("/preview")) return jsonResponse(previewBody());
      throw new Error("confirm should not run");
    },
  });
  await session.preview("cp-1", "/repo", "/repo");
  assert.equal(await session.confirm("cp-2", "/repo", "/repo"), false);
  assert.equal(await session.confirm("cp-1", "/other", "/repo"), false);
  assert.equal(await session.confirm("cp-1", "/repo", "/other"), false);
  assert.equal(session.getSnapshot().preview?.checkpointId, "cp-1");
  assert.equal(session.getSnapshot().busy, false);
});

test("workspace rewind confirm requires a preview", async () => {
  let called = false;
  const session = new WorkspaceRewindSessionModule({
    request: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  assert.equal(await session.confirm("cp-1", "/repo", "/repo"), false);
  assert.equal(called, false);
});

test("workspace rewind keeps the fallback when preview error JSON is malformed", async () => {
  const session = new WorkspaceRewindSessionModule({
    request: async () => jsonResponse(null, 500),
  });
  await session.preview("cp-1", "/repo", "/repo");
  assert.equal(session.getSnapshot().error, "The rewind preview could not be prepared.");
  assert.equal(session.getSnapshot().busy, false);
});

test("workspace rewind keeps the fallback when confirm error JSON is malformed", async () => {
  const session = new WorkspaceRewindSessionModule({
    request: async (input) => {
      if (String(input).endsWith("/preview")) return jsonResponse(previewBody());
      return jsonResponse(null, 500);
    },
  });
  await session.preview("cp-1", "/repo", "/repo");
  assert.equal(await session.confirm("cp-1", "/repo", "/repo"), false);
  assert.equal(session.getSnapshot().error, "The workspace could not be rewound.");
  assert.equal(session.getSnapshot().busy, false);
});

test("workspace rewind ignores a stale confirm after reset", async () => {
  let resolveConfirm!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveConfirm = resolve;
  });
  const session = new WorkspaceRewindSessionModule({
    request: async (input) => {
      if (String(input).endsWith("/preview")) return jsonResponse(previewBody());
      return pending;
    },
  });
  await session.preview("cp-1", "/repo", "/repo");
  const first = session.confirm("cp-1", "/repo", "/repo");
  session.reset();
  resolveConfirm(jsonResponse({}));
  assert.equal(await first, false);
  assert.equal(session.getSnapshot().preview, null);
  assert.equal(session.getSnapshot().busy, false);
});
