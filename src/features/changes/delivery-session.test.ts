import assert from "node:assert/strict";
import test from "node:test";
import type { DeliveryContext, DeliveryPlan, PullRequestDraft } from "../../types";
import { ReviewedDeliverySessionModule } from "./delivery-session";

const context = (): DeliveryContext => ({
  repository: "/repo",
  worktree: "/repo",
  branch: "codex/topic",
  detached: false,
  upstream: "origin/codex/topic",
  remotes: [{ name: "origin", url: "https://example.test/repo.git" }],
  staged: [],
  unstaged: ["src/a.ts"],
});

const plan = (): DeliveryPlan => ({
  id: "plan-1",
  action: "stage",
  summary: "Stage 1 file",
  repository: "/repo",
  worktree: "/repo",
  branch: "codex/topic",
  remote: null,
  destination: null,
  details: ["src/a.ts"],
  expiresAt: "2026-08-13T12:00:00.000Z",
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("reviewed delivery inspects context and seeds the first remote", async () => {
  const session = new ReviewedDeliverySessionModule({
    request: async (input) => {
      assert.equal(input, "/api/delivery/inspect");
      return jsonResponse(context());
    },
  });
  await session.inspect("/repo", "/repo");
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.context?.branch, "codex/topic");
  assert.equal(snapshot.remote, "origin");
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.error, null);
});

test("reviewed delivery ignores a stale inspect after reset", async () => {
  let resolveInspect!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveInspect = resolve;
  });
  const session = new ReviewedDeliverySessionModule({
    request: async () => pending,
  });
  const first = session.inspect("/repo", "/repo");
  session.reset();
  resolveInspect(jsonResponse(context()));
  await first;
  assert.equal(session.getSnapshot().context, null);
  assert.equal(session.getSnapshot().loading, false);
});

test("reviewed delivery prepare stages selected paths", async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const session = new ReviewedDeliverySessionModule({
    request: async (input, init) => {
      calls.push({ route: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      if (String(input) === "/api/delivery/plans") return jsonResponse(plan());
      return jsonResponse(context());
    },
  });
  session.toggleSelectedPaths(["src/a.ts", "old.ts"], true);
  await session.prepare("/repo", "/worktree");
  assert.deepEqual(calls[0]?.body, {
    root: "/repo",
    worktree: "/worktree",
    action: "stage",
    input: { paths: ["src/a.ts", "old.ts"] },
  });
  assert.equal(session.getSnapshot().plan?.id, "plan-1");
  assert.equal(session.getSnapshot().busy, false);
});

test("reviewed delivery execute clears the plan and reinspects", async () => {
  const calls: string[] = [];
  let refreshed = 0;
  const session = new ReviewedDeliverySessionModule({
    request: async (input) => {
      calls.push(String(input));
      if (String(input).includes("/execute")) return jsonResponse({});
      if (String(input) === "/api/delivery/inspect") return jsonResponse(context());
      return jsonResponse(plan());
    },
  });
  await session.prepare("/repo", "/repo");
  await session.execute("/repo", "/repo", () => {
    refreshed += 1;
  });
  assert.deepEqual(calls, [
    "/api/delivery/plans",
    "/api/delivery/plans/plan-1/execute",
    "/api/delivery/inspect",
  ]);
  assert.equal(session.getSnapshot().plan, null);
  assert.equal(session.getSnapshot().selectedPaths.length, 0);
  assert.equal(session.getSnapshot().context?.branch, "codex/topic");
  assert.equal(refreshed, 1);
});

test("reviewed delivery keeps the fallback when error JSON is malformed", async () => {
  const session = new ReviewedDeliverySessionModule({
    request: async () => jsonResponse(null, 500),
  });
  await session.inspect("/repo", "/repo");
  assert.equal(session.getSnapshot().error, "Delivery state could not be inspected.");
});

test("reviewed delivery draft writes title and body from the host", async () => {
  const draft: PullRequestDraft = {
    title: "feat: topic",
    body: "Why this lands.",
    branch: "codex/topic",
    base: "main",
    changedFiles: ["src/a.ts"],
    omittedFiles: 0,
  };
  const session = new ReviewedDeliverySessionModule({
    request: async (input, init) => {
      assert.equal(input, "/api/delivery/pr-draft");
      assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), {
        root: "/repo",
        worktree: "/repo",
        base: "main",
      });
      return jsonResponse(draft);
    },
  });
  await session.generatePullRequestDraft("/repo", "/repo");
  assert.equal(session.getSnapshot().title, "feat: topic");
  assert.equal(session.getSnapshot().body, "Why this lands.");
  assert.equal(session.getSnapshot().busy, false);
});

test("reviewed delivery changing action clears a pending plan", () => {
  const session = new ReviewedDeliverySessionModule({
    request: async () => jsonResponse(plan()),
  });
  session.setAction("commit");
  assert.equal(session.getSnapshot().action, "commit");
  assert.equal(session.getSnapshot().plan, null);
});

test("reviewed delivery input changes clear a pending plan", async () => {
  const session = new ReviewedDeliverySessionModule({
    request: async (input) => {
      if (String(input) === "/api/delivery/plans") return jsonResponse(plan());
      return jsonResponse(context());
    },
  });
  await session.prepare("/repo", "/repo");
  session.setMessage("feat: topic");
  assert.equal(session.getSnapshot().plan, null);
  await session.prepare("/repo", "/repo");
  session.setRemote("origin");
  assert.equal(session.getSnapshot().plan, null);
  await session.prepare("/repo", "/repo");
  session.setBase("develop");
  assert.equal(session.getSnapshot().plan, null);
  await session.prepare("/repo", "/repo");
  session.setTitle("Title");
  assert.equal(session.getSnapshot().plan, null);
  await session.prepare("/repo", "/repo");
  session.setBody("Body");
  assert.equal(session.getSnapshot().plan, null);
  await session.prepare("/repo", "/repo");
  session.toggleSelectedPaths(["src/a.ts"], true);
  assert.equal(session.getSnapshot().plan, null);
});

test("reviewed delivery ignores a stale prepare after the form changes", async () => {
  let resolvePrepare!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolvePrepare = resolve;
  });
  const session = new ReviewedDeliverySessionModule({
    request: async () => pending,
  });
  const first = session.prepare("/repo", "/repo");
  session.setMessage("later");
  assert.equal(session.getSnapshot().busy, true);
  assert.equal(session.getSnapshot().plan, null);
  resolvePrepare(jsonResponse(plan()));
  await first;
  assert.equal(session.getSnapshot().plan, null);
  assert.equal(session.getSnapshot().busy, false);
  assert.equal(session.getSnapshot().message, "later");
});

test("reviewed delivery stale prepare does not idle a newer prepare", async () => {
  const resolvers: Array<(response: Response) => void> = [];
  const session = new ReviewedDeliverySessionModule({
    request: async () =>
      new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      }),
  });
  const first = session.prepare("/repo", "/repo");
  const second = session.prepare("/repo", "/repo");
  resolvers[0]!(jsonResponse(plan()));
  await first;
  assert.equal(session.getSnapshot().busy, true);
  assert.equal(session.getSnapshot().plan, null);
  resolvers[1]!(jsonResponse({ ...plan(), id: "plan-2" }));
  await second;
  assert.equal(session.getSnapshot().plan?.id, "plan-2");
  assert.equal(session.getSnapshot().busy, false);
});

test("reviewed delivery resetScope keeps authored drafts", async () => {
  const session = new ReviewedDeliverySessionModule({
    request: async () => jsonResponse(context()),
  });
  session.setAction("commit");
  session.setMessage("feat: topic");
  session.setBase("develop");
  session.setTitle("Title");
  session.setBody("Body");
  session.toggleSelectedPaths(["src/a.ts"], true);
  await session.inspect("/repo", "/repo");
  session.resetScope();
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.action, "commit");
  assert.equal(snapshot.message, "feat: topic");
  assert.equal(snapshot.base, "develop");
  assert.equal(snapshot.title, "Title");
  assert.equal(snapshot.body, "Body");
  assert.equal(snapshot.context, null);
  assert.equal(snapshot.plan, null);
  assert.deepEqual(snapshot.selectedPaths, []);
  assert.equal(snapshot.remote, "");
});
