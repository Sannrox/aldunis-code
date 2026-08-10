import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleProviderAdapterRoute } from "./provider-adapter-routes.ts";
import { ProviderAdapterError, type InstalledProviderAdapter } from "./provider-adapters.ts";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

const installedAdapter: InstalledProviderAdapter = {
  schemaVersion: 1,
  source: "/host/reviewed/example.json",
  digest: `sha256:${"a".repeat(64)}`,
  enabled: true,
  installedAt: "2026-08-10T20:00:00.000Z",
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
      { name: "EXAMPLE_TOKEN", required: false, sensitive: true },
      { name: "OPTIONAL", required: false, sensitive: false },
    ],
    presentation: { name: "Example Agent", description: "Example adapter" },
  },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    adapters: {
      list: unused,
      inspect: () => assert.fail("dependency must not be called"),
      install: unused,
      update: unused,
      setEnabled: unused,
      rollback: unused,
      uninstall: unused,
    },
    profiles: { ensureProviderDefault: unused },
    listReviewedAdapters: unused,
    prepareReviewedAdapter: unused,
    remote: false,
    managed: false,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("provider adapter module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleProviderAdapterRoute(
      "/api/provider/profiles/list",
      request,
      response,
      context() as never,
    ),
    false,
  );
});

test("provider adapter module suppresses managed administration without reading stores", async () => {
  const writes: unknown[] = [];
  assert.equal(
    await handleProviderAdapterRoute(
      "/api/provider/adapters/list",
      request,
      response,
      context({
        managed: true,
        sendJson: (_response: ServerResponse, status: number, value: unknown) =>
          writes.push({ status, value }),
      }) as never,
    ),
    true,
  );
  assert.deepEqual(writes, [
    { status: 200, value: { adapters: [], administrationAvailable: false } },
  ]);
});

test("provider adapter module redacts remote host details", async () => {
  const writes: unknown[] = [];
  await handleProviderAdapterRoute(
    "/api/provider/adapters/list",
    request,
    response,
    context({
      remote: true,
      adapters: { ...context().adapters, list: async () => [installedAdapter] },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  const value = (writes[0] as { value: { adapters: InstalledProviderAdapter[] } }).value;
  assert.equal(value.adapters[0].source, "Source available on host only");
  assert.equal(
    (writes[0] as { value: { administrationAvailable: boolean } }).value.administrationAvailable,
    false,
  );
});

test("provider adapter module redacts remote reviewed packages and executable paths", async () => {
  const writes: unknown[] = [];
  await handleProviderAdapterRoute(
    "/api/provider/adapters/catalog",
    request,
    response,
    context({
      remote: true,
      listReviewedAdapters: async () => [
        {
          source: "/host/reviewed/example.json",
          package: { source: "/host/reviewed/example.json" },
          executableFound: true,
          executablePath: "/usr/local/bin/example-agent",
        },
      ],
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  const entry = (
    writes[0] as {
      value: { adapters: Array<{ source: string; package: unknown; executablePath: string }> };
    }
  ).value.adapters[0];
  assert.deepEqual(entry, {
    source: "Reviewed package available on host only",
    package: null,
    executableFound: true,
    executablePath: "available on host",
  });
});

test("provider adapter module denies remote mutations before reading a request body", async () => {
  await assert.rejects(
    handleProviderAdapterRoute(
      "/api/provider/adapters/example.agent/enable",
      request,
      response,
      context({ remote: true }) as never,
    ),
    (error: unknown) => error instanceof ProviderAdapterError && error.status === 403,
  );
});

test("provider adapter module requires approval before store mutation", async () => {
  await assert.rejects(
    handleProviderAdapterRoute(
      "/api/provider/adapters/install",
      request,
      response,
      context({ readJson: async () => ({ approved: false }) }) as never,
    ),
    (error: unknown) => error instanceof ProviderAdapterError && error.status === 403,
  );
});

test("provider adapter module seeds a default profile after installation", async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  await handleProviderAdapterRoute(
    "/api/provider/adapters/install",
    request,
    response,
    context({
      readJson: async () => ({ approved: true }),
      adapters: {
        ...context().adapters,
        install: async () => {
          calls.push("install");
          return installedAdapter;
        },
      },
      profiles: {
        ensureProviderDefault: async (seed: { provider: string; environment?: unknown[] }) => {
          calls.push(`profile:${seed.provider}:${seed.environment?.length}`);
          return {};
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) => {
        calls.push("response");
        writes.push({ status, value });
      },
    }) as never,
  );
  assert.deepEqual(calls, ["install", "profile:adapter:example.agent@1.0.0:1", "response"]);
  assert.deepEqual(writes, [{ status: 200, value: installedAdapter }]);
});

test("provider adapter module routes approved adapter actions", async () => {
  const calls: unknown[] = [];
  await handleProviderAdapterRoute(
    "/api/provider/adapters/example.agent/disable",
    request,
    response,
    context({
      readJson: async () => ({ approved: true }),
      adapters: {
        ...context().adapters,
        setEnabled: async (id: string, enabled: boolean) => {
          calls.push({ id, enabled });
          return installedAdapter;
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        calls.push({ status, value }),
    }) as never,
  );
  assert.deepEqual(calls, [
    { id: "example.agent", enabled: false },
    { status: 200, value: installedAdapter },
  ]);
});
