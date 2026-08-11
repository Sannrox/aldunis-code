import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { PreviewError } from "./preview.ts";
import { handlePreviewRoute } from "./preview-routes.ts";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    previews: {
      requestStart: unused,
      decide: () => assert.fail("must not decide"),
      snapshot: () => assert.fail("must not load"),
      stop: unused,
    },
    selectWorktree: unused,
    readJson: unused,
    sendJson: () => assert.fail("must not respond"),
    ...overrides,
  };
}

test("preview route module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handlePreviewRoute("/api/state/load", request, response, context() as never),
    false,
  );
});

test("preview request validates, canonicalizes, and starts through one interface", async () => {
  const calls: string[] = [];
  assert.equal(
    await handlePreviewRoute(
      "/api/previews/request",
      request,
      response,
      context({
        readJson: async () => ({
          root: "/repo",
          worktree: "/repo/link",
          origin: "http://localhost:4173",
        }),
        selectWorktree: async (root: string, worktree: string) => {
          calls.push(`select:${root}:${worktree}`);
          return { root: "/canonical/repo", worktree: "/canonical/repo/worktree" };
        },
        previews: {
          requestStart: async (root: string, worktree: string, origin: string) => {
            calls.push(`start:${root}:${worktree}:${origin}`);
            return { id: "preview-1" };
          },
        },
        sendJson: (_response: ServerResponse, status: number, body: unknown) => {
          assert.equal(status, 200);
          assert.deepEqual(body, { id: "preview-1" });
          calls.push("respond");
        },
      }) as never,
    ),
    true,
  );
  assert.deepEqual(calls, [
    "select:/repo:/repo/link",
    "start:/canonical/repo:/canonical/repo/worktree:http://localhost:4173",
    "respond",
  ]);
});

test("preview decision rejects an invalid scope before canonical selection", async () => {
  await assert.rejects(
    handlePreviewRoute(
      "/api/previews/0123abcd/decide",
      request,
      response,
      context({
        readJson: async () => ({ root: "/repo", worktree: "/repo/w", decision: "always" }),
      }) as never,
    ),
    (error: unknown) => error instanceof PreviewError && error.status === 400,
  );
});

test("preview decision binds the canonical worktree and maps its snapshot", async () => {
  await handlePreviewRoute(
    "/api/previews/0123abcd/decide",
    request,
    response,
    context({
      readJson: async () => ({ root: "/repo", worktree: "/repo/w", decision: "deny" }),
      selectWorktree: async () => ({ root: "/canonical/repo", worktree: "/canonical/repo/w" }),
      previews: {
        decide: (id: string, selected: unknown, decision: string) => {
          assert.equal(id, "0123abcd");
          assert.deepEqual(selected, {
            repository: "/canonical/repo",
            worktree: "/canonical/repo/w",
          });
          assert.equal(decision, "deny");
          return { id, state: "stopped" };
        },
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { id: "0123abcd", state: "stopped" });
      },
    }) as never,
  );
});

test("preview status reads without a body or worktree", async () => {
  await handlePreviewRoute(
    "/api/previews/0123abcd/status",
    request,
    response,
    context({
      previews: { snapshot: (id: string) => ({ id, state: "running" }) },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { id: "0123abcd", state: "running" });
      },
    }) as never,
  );
});

test("preview stop canonicalizes scope before stopping", async () => {
  await handlePreviewRoute(
    "/api/previews/0123abcd/stop",
    request,
    response,
    context({
      readJson: async () => ({ root: "/repo", worktree: "/repo/w" }),
      selectWorktree: async () => ({ root: "/canonical/repo", worktree: "/canonical/repo/w" }),
      previews: {
        stop: async (id: string, selected: unknown) => {
          assert.equal(id, "0123abcd");
          assert.deepEqual(selected, {
            repository: "/canonical/repo",
            worktree: "/canonical/repo/w",
          });
          return { id, state: "stopped" };
        },
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { id: "0123abcd", state: "stopped" });
      },
    }) as never,
  );
});

test("preview routes reject incomplete scoped payloads", async () => {
  for (const [route, body, message] of [
    [
      "/api/previews/request",
      { root: "/repo", worktree: "/repo/w" },
      "A repository, worktree, and loopback origin are required.",
    ],
    ["/api/previews/0123abcd/stop", { root: "/repo" }, "A repository and worktree are required."],
  ] as const) {
    await assert.rejects(
      handlePreviewRoute(
        route,
        request,
        response,
        context({ readJson: async () => body }) as never,
      ),
      (error: unknown) => error instanceof PreviewError && error.message === message,
    );
  }
});
