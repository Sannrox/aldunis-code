import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { PermissionError } from "./permission.ts";
import {
  handleProviderControlRoute,
  handleProviderPermissionRequest,
} from "./provider-control-routes.ts";
import { RepositoryError } from "./repository.ts";
import { LocalStateError } from "./state.ts";

const response = {} as ServerResponse;
const request = (authorization?: string, localPort?: number) =>
  ({ headers: authorization ? { authorization } : {}, socket: { localPort } }) as IncomingMessage;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    provider: { capabilities: () => ({ attachments: { images: true } }), cancel: () => false },
    codex: { skills: unused, cancel: () => false },
    shikigami: { cancel: () => false },
    permissions: { approvalsFor: () => [], awaitDecision: unused },
    activeAcp: new Map(),
    managed: false,
    selectWorktree: unused,
    startRun: () => assert.fail("run must not start"),
    readJson: unused,
    sendJson: () => assert.fail("must not respond"),
    ...overrides,
  };
}

test("provider control module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleProviderControlRoute("/api/state/load", request(), response, context() as never),
    false,
  );
});

test("provider capabilities preserve local and managed projections", async () => {
  const bodies: unknown[] = [];
  const sendJson = (_response: ServerResponse, status: number, body: unknown) => {
    assert.equal(status, 200);
    bodies.push(body);
  };
  await handleProviderControlRoute(
    "/api/provider/capabilities",
    request(),
    response,
    context({ sendJson }) as never,
  );
  await handleProviderControlRoute(
    "/api/provider/capabilities",
    request(),
    response,
    context({ managed: true, sendJson }) as never,
  );
  assert.deepEqual(bodies, [
    { attachments: { images: true } },
    {
      provider: "shikigami",
      commands: [],
      attachments: { images: true },
      workspace: {
        shared: true,
        aldunisManaged: true,
        providerNative: false,
        providerNativeDetail:
          "Managed hosted mode supplies the workspace; provider-native worktree creation is unavailable.",
      },
    },
  ]);
});

test("provider skills deny managed mode before input and canonicalize local worktrees", async () => {
  await assert.rejects(
    handleProviderControlRoute(
      "/api/provider/skills",
      request(),
      response,
      context({ managed: true }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
  await handleProviderControlRoute(
    "/api/provider/skills",
    request(),
    response,
    context({
      readJson: async () => ({ provider: "codex-cli", root: "/repo", worktree: "/repo/link" }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/repo/canonical" }),
      codex: {
        skills: async (worktree: string) => {
          assert.equal(worktree, "/repo/canonical");
          return [{ name: "review" }];
        },
        cancel: () => false,
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { skills: [{ name: "review" }] });
      },
    }) as never,
  );
});

test("provider skills require exact provider and workspace input", async () => {
  await assert.rejects(
    handleProviderControlRoute(
      "/api/provider/skills",
      request(),
      response,
      context({ readJson: async () => ({ provider: "claude-code" }) }) as never,
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 400,
  );
});

test("approval listing validates the run before projecting approvals", async () => {
  await assert.rejects(
    handleProviderControlRoute(
      "/api/provider/approvals/list",
      request(),
      response,
      context({ readJson: async () => ({}) }) as never,
    ),
    (error: unknown) => error instanceof PermissionError,
  );
  await handleProviderControlRoute(
    "/api/provider/approvals/list",
    request(),
    response,
    context({
      readJson: async () => ({ runId: "run-1" }),
      permissions: {
        approvalsFor: (runId: string) => {
          assert.equal(runId, "run-1");
          return [{ id: "approval-1" }];
        },
        awaitDecision: unused,
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { approvals: [{ id: "approval-1" }] });
      },
    }) as never,
  );
});

test("permission request interface validates bearer authority and delegates exact input", async () => {
  await assert.rejects(
    handleProviderPermissionRequest(request(), response, {
      permissions: { awaitDecision: unused },
      readJson: async () => ({ runId: "run-1", toolName: "write" }),
      sendJson: () => assert.fail(),
    } as never),
    (error: unknown) => error instanceof PermissionError && error.status === 403,
  );
  const input = { path: "file.ts" };
  await handleProviderPermissionRequest(request("Bearer token"), response, {
    permissions: {
      awaitDecision: async (runId: string, token: string, toolName: string, actual: unknown) => {
        assert.deepEqual([runId, token, toolName, actual], ["run-1", "token", "write", input]);
        return { decision: "deny" };
      },
    },
    readJson: async () => ({ runId: "run-1", toolName: "write", input }),
    sendJson: (_response: ServerResponse, status: number, body: unknown) => {
      assert.equal(status, 200);
      assert.deepEqual(body, { decision: "deny" });
    },
  } as never);
});

test("provider run preserves accepted and completion semantics", async () => {
  let acceptedObserved = false;
  assert.equal(
    await handleProviderControlRoute(
      "/api/provider/runs",
      request(undefined, 4174),
      response,
      context({
        readJson: async () => ({ prompt: "test" }),
        startRun: (body: unknown, port: number, output: ServerResponse) => {
          assert.deepEqual(body, { prompt: "test" });
          assert.equal(port, 4174);
          assert.equal(output, response);
          return {
            accepted: Promise.reject(new Error("rejected before admission")).finally(() => {
              acceptedObserved = true;
            }),
            completed: Promise.resolve(true),
          };
        },
      }) as never,
    ),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acceptedObserved, true);
});

test("provider cancellation preserves adapter order and ACP fallback", async () => {
  const calls: string[] = [];
  await handleProviderControlRoute(
    "/api/provider/runs/0123abcd/cancel",
    request(),
    response,
    context({
      provider: {
        capabilities: () => ({}),
        cancel: () => {
          calls.push("claude");
          return false;
        },
      },
      codex: {
        skills: unused,
        cancel: () => {
          calls.push("codex");
          return false;
        },
      },
      shikigami: {
        cancel: () => {
          calls.push("shikigami");
          return false;
        },
      },
      activeAcp: new Map([
        [
          "0123abcd",
          {
            cancel: () => {
              calls.push("acp");
              return true;
            },
          },
        ],
      ]),
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 202);
        assert.deepEqual(body, { status: "cancelling" });
      },
    }) as never,
  );
  assert.deepEqual(calls, ["claude", "codex", "shikigami", "acp"]);
});

test("provider cancellation fails when every adapter is inactive", async () => {
  await assert.rejects(
    handleProviderControlRoute(
      "/api/provider/runs/0123abcd/cancel",
      request(),
      response,
      context() as never,
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 404,
  );
});
