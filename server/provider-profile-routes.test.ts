import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleProviderProfileRoute } from "./provider-profile-routes.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";
import { ProfileError } from "./profiles.ts";
import { RepositoryError } from "./repository.ts";

const request = Object.assign(new EventEmitter(), { aborted: false }) as IncomingMessage;
const response = Object.assign(new EventEmitter(), {
  destroyed: false,
  writableEnded: false,
}) as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};
const adapter: InstalledProviderAdapter = {
  schemaVersion: 1,
  source: "/reviewed/example.json",
  digest: `sha256:${"a".repeat(64)}`,
  enabled: true,
  installedAt: "2026-08-11T00:00:00.000Z",
  manifest: {
    schemaVersion: 1,
    id: "example.agent",
    publisher: { name: "Example" },
    version: "1.0.0",
    aldunis: { minimumVersion: "0.1.0", maximumVersion: "0.1.0" },
    protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
    executable: { names: ["example-agent"], arguments: ["--acp"] },
    capabilities: { tools: true, images: false, sessionResume: true },
    environment: [
      { name: "TOKEN", required: true, sensitive: true },
      { name: "OPTIONAL", required: false, sensitive: false },
    ],
    presentation: { name: "Example Agent", description: "Example" },
  },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    profiles: { list: unused, save: unused, delete: unused, refresh: unused },
    adapters: { list: unused },
    providerDiscovery: { discover: unused },
    remote: false,
    managed: false,
    defaultDiscoveryCwd: "/default",
    selectWorktree: unused,
    readJson: unused,
    readOptionalJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("provider profile module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleProviderProfileRoute("/api/provider/runs", request, response, context() as never),
    false,
  );
});

test("provider discovery uses the default cwd when no worktree is supplied", async () => {
  const writes: unknown[] = [];
  await handleProviderProfileRoute(
    "/api/providers/discover",
    request,
    response,
    context({
      readOptionalJson: async () => ({}),
      providerDiscovery: {
        discover: async (input: { cwd: string; signal: AbortSignal }) => ({
          cwd: input.cwd,
          aborted: input.signal.aborted,
        }),
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  assert.deepEqual(writes, [{ status: 200, value: { cwd: "/default", aborted: false } }]);
});

test("provider discovery canonicalizes an explicitly selected worktree", async () => {
  const calls: unknown[] = [];
  await handleProviderProfileRoute(
    "/api/providers/discover",
    request,
    response,
    context({
      readOptionalJson: async () => ({ root: "/repo", worktree: "/repo/work" }),
      selectWorktree: async (root: string, worktree: string) => {
        calls.push({ root, worktree });
        return { worktree: "/canonical/work" };
      },
      providerDiscovery: {
        discover: async (input: { cwd: string; signal: AbortSignal }) =>
          calls.push({ cwd: input.cwd, aborted: input.signal.aborted }),
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.deepEqual(calls, [
    { root: "/repo", worktree: "/repo/work" },
    { cwd: "/canonical/work", aborted: false },
  ]);
});

test("provider discovery cancels disconnected work and releases lifecycle listeners", async () => {
  const activeRequest = Object.assign(new EventEmitter(), { aborted: false }) as IncomingMessage;
  const activeResponse = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as ServerResponse;
  let observedSignal: AbortSignal | undefined;
  let wrote = false;
  const pending = handleProviderProfileRoute(
    "/api/providers/discover",
    activeRequest,
    activeResponse,
    context({
      readOptionalJson: async () => ({}),
      providerDiscovery: {
        discover: async ({ signal }: { signal: AbortSignal }) => {
          observedSignal = signal;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
      sendJson: () => {
        wrote = true;
      },
    }) as never,
  );
  while (!observedSignal) await new Promise((resolve) => setImmediate(resolve));

  activeResponse.emit("close");

  await assert.rejects(
    pending,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  assert.equal(observedSignal.aborted, true);
  assert.equal(wrote, false);
  assert.equal(activeRequest.listenerCount("aborted"), 0);
  assert.equal(activeResponse.listenerCount("close"), 0);
});

test("provider discovery rejects a disconnect observed before lifecycle registration", async () => {
  const closedRequest = Object.assign(new EventEmitter(), { aborted: true }) as IncomingMessage;
  const closedResponse = Object.assign(new EventEmitter(), {
    destroyed: true,
    writableEnded: false,
  }) as ServerResponse;
  let discovered = false;

  await assert.rejects(
    handleProviderProfileRoute(
      "/api/providers/discover",
      closedRequest,
      closedResponse,
      context({
        providerDiscovery: {
          discover: async () => {
            discovered = true;
          },
        },
      }) as never,
    ),
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  assert.equal(discovered, false);
  assert.equal(closedRequest.listenerCount("aborted"), 0);
  assert.equal(closedResponse.listenerCount("close"), 0);
});

test("provider discovery rejects incomplete worktree context", async () => {
  await assert.rejects(
    handleProviderProfileRoute(
      "/api/providers/discover",
      request,
      response,
      context({ readOptionalJson: async () => ({ root: "/repo" }) }) as never,
    ),
    (error: unknown) => error instanceof RepositoryError,
  );
});

test("managed profile listing avoids stores and reports unavailable administration", async () => {
  const writes: unknown[] = [];
  await handleProviderProfileRoute(
    "/api/provider/profiles/list",
    request,
    response,
    context({
      managed: true,
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  assert.deepEqual(writes, [
    { status: 200, value: { profiles: [], administrationAvailable: false } },
  ]);
});

test("profile listing seeds installed adapters behind the route interface", async () => {
  const calls: unknown[] = [];
  await handleProviderProfileRoute(
    "/api/provider/profiles/list",
    request,
    response,
    context({
      adapters: { list: async () => [adapter] },
      profiles: {
        ...context().profiles,
        list: async (options: unknown) => {
          calls.push(options);
          return [];
        },
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.deepEqual(calls, [
    {
      adapters: [
        {
          provider: "adapter:example.agent@1.0.0",
          name: "Example Agent",
          binaryPath: "example-agent",
          environment: [{ name: "TOKEN", sensitive: true, value: "" }],
        },
      ],
    },
  ]);
});

test("remote profile mutation fails before reading sensitive input", async () => {
  await assert.rejects(
    handleProviderProfileRoute(
      "/api/provider/profiles/save",
      request,
      response,
      context({ remote: true }) as never,
    ),
    (error: unknown) => error instanceof ProfileError && error.status === 403,
  );
});

test("profile save normalizes valid environment fields", async () => {
  const calls: unknown[] = [];
  await handleProviderProfileRoute(
    "/api/provider/profiles/save",
    request,
    response,
    context({
      readJson: async () => ({
        name: "Local",
        environment: [{ name: "TOKEN", sensitive: true, valueSet: true }],
      }),
      profiles: {
        ...context().profiles,
        save: async (input: unknown) => {
          calls.push(input);
          return input;
        },
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.deepEqual(calls, [
    {
      name: "Local",
      environment: [{ name: "TOKEN", sensitive: true, valueSet: true }],
    },
  ]);
});

test("profile save rejects malformed environment fields", async () => {
  await assert.rejects(
    handleProviderProfileRoute(
      "/api/provider/profiles/save",
      request,
      response,
      context({
        readJson: async () => ({
          name: "Local",
          environment: [{ name: "TOKEN", sensitive: "yes" }],
        }),
      }) as never,
    ),
    (error: unknown) => error instanceof ProfileError,
  );
});

test("profile delete and refresh validate then dispatch", async () => {
  const calls: unknown[] = [];
  const shared = context({
    readJson: async () => ({ id: "profile-1", kind: "models" }),
    profiles: {
      ...context().profiles,
      delete: async (id: string) => calls.push({ delete: id }),
      refresh: async (id: string, kind: string) => {
        calls.push({ refresh: [id, kind] });
        return { id, kind };
      },
    },
    sendJson: () => undefined,
  }) as never;
  await handleProviderProfileRoute("/api/provider/profiles/delete", request, response, shared);
  await handleProviderProfileRoute("/api/provider/profiles/refresh", request, response, shared);
  assert.deepEqual(calls, [{ delete: "profile-1" }, { refresh: ["profile-1", "models"] }]);
});
