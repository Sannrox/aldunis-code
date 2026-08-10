import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChiseiProjectionClient } from "./chisei-client.ts";
import { createLocalHost } from "./host.ts";
import { ClaudeProfileStore } from "./profiles.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { LocalStateStore } from "./state.ts";

async function fixture(remote = false) {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-chisei-routes-"));
  const state = new LocalStateStore(directory);
  await state.saveProject({ id: "project-1", name: "Project", root: directory });
  const calls: Array<{ projectId: string; namespace: string }> = [];
  const observationCalls: Array<{ namespace: string; requestId: string }> = [];
  const chisei = {
    async listActions(projectId: string, namespace: string) {
      calls.push({ projectId, namespace });
      return { state: "live", fetchedAt: new Date(0).toISOString(), actions: [], warning: null };
    },
    async actionDetail(namespace: string, instanceId: string) {
      return {
        action: {
          instanceId,
          namespace,
          typeId: "review",
          version: "1",
          operationId: "operation-1",
          status: "admitted",
          createdAt: new Date(0).toISOString(),
          decidedAt: null,
        },
        effects: [],
        receipt: {
          operationId: "operation-1",
          complete: true,
          missingSurfaces: [],
          eventCount: 1,
        },
      };
    },
    async operationReceipt(operationId: string) {
      return {
        operationId,
        complete: true,
        missingSurfaces: [],
        eventCount: 2,
      };
    },
    async sampleObservation(namespace: string, requestId: string) {
      observationCalls.push({ namespace, requestId });
      return {
        requestId,
        namespace,
        observationDigest: `sha256:${"a".repeat(64)}`,
        state: "recorded",
        observedAt: new Date(1_000).toISOString(),
        readAt: new Date(2_000).toISOString(),
      };
    },
  } as unknown as ChiseiProjectionClient;
  const remoteAuth = remote ? ({ verify: async () => ({}) } as unknown as RemoteAuth) : undefined;
  const server = createLocalHost({
    dist: directory,
    state,
    profiles: new ClaudeProfileStore(directory),
    remoteAuth,
    chisei,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    calls,
    observationCalls,
    server,
    state,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function post(url: string, route: string, body: unknown) {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function close(server: ReturnType<typeof createLocalHost>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("Chisei reads derive namespace authority from the local project binding", async () => {
  const current = await fixture();
  try {
    const bound = await post(current.url, "/api/integrations/chisei/bind", {
      projectId: "project-1",
      namespace: "team/project",
    });
    assert.equal(bound.status, 200);
    const listed = await post(current.url, "/api/integrations/chisei/actions/list", {
      projectId: "project-1",
      namespace: "attacker/override",
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(current.calls, [{ projectId: "project-1", namespace: "team/project" }]);
    assert.equal((await current.state.load()).projects[0].chiseiNamespace, "team/project");
  } finally {
    await close(current.server);
  }
});

test("browser clients cannot administer Chisei bindings when remote access is enabled", async () => {
  const current = await fixture(true);
  try {
    const response = await post(current.url, "/api/integrations/chisei/bind", {
      projectId: "project-1",
      namespace: "other/project",
    });
    assert.equal(response.status, 403);
    assert.equal((await current.state.load()).projects[0].chiseiNamespace ?? null, null);
  } finally {
    await close(current.server);
  }
});

test("operation inspection derives authority from a persisted project correlation", async () => {
  const current = await fixture();
  try {
    await current.state.saveProject({ id: "project-2", name: "Other", root: `${tmpdir()}/other` });
    const { thread, turn } = await current.state.startTurn({
      projectId: "project-1",
      worktree: (await current.state.load()).projects[0].root,
      prompt: "governed run",
      mode: "build",
      provider: "shikigami",
    });
    const operationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await current.state.recordProviderEvent(thread.id, turn.id, "shikigami", {
      kind: "governance_correlation",
      governance: "sekai-chisei",
      runId: operationId,
      operationId,
    });
    const correlationId = (await current.state.load()).governanceCorrelations[0].id;
    const allowed = await post(current.url, "/api/integrations/chisei/operations/detail", {
      projectId: "project-1",
      correlationId,
      operationId: "attacker-selected-id",
    });
    assert.equal(allowed.status, 200);
    assert.equal(((await allowed.json()) as { operationId: string }).operationId, operationId);
    const denied = await post(current.url, "/api/integrations/chisei/operations/detail", {
      projectId: "project-2",
      correlationId,
    });
    assert.equal(denied.status, 404);
  } finally {
    await close(current.server);
  }
});

test("sample-observation readback derives namespace authority from the local project binding", async () => {
  const current = await fixture();
  try {
    await current.state.bindProjectChiseiNamespace("project-1", "team/project");
    const response = await post(current.url, "/api/integrations/chisei/observations/detail", {
      projectId: "project-1",
      requestId: "tenkai:outcome:v2:event-1",
      namespace: "attacker/override",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      requestId: "tenkai:outcome:v2:event-1",
      namespace: "team/project",
      observationDigest: `sha256:${"a".repeat(64)}`,
      state: "recorded",
      observedAt: new Date(1_000).toISOString(),
      readAt: new Date(2_000).toISOString(),
    });
    assert.deepEqual(current.observationCalls, [
      {
        namespace: "team/project",
        requestId: "tenkai:outcome:v2:event-1",
      },
    ]);
  } finally {
    await close(current.server);
  }
});
