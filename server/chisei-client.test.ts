import assert from "node:assert/strict";
import test from "node:test";
import type { Metadata } from "@grpc/grpc-js";
import {
  ChiseiClientError,
  ChiseiProjectionClient,
} from "./chisei-client.ts";

type Handler = (
  request: Record<string, unknown>,
  metadata: Metadata,
  callback: (error: ({ code?: number } & Error) | null, response?: unknown) => void,
) => void;

function fixtureClient(handlers: Record<string, Handler>) {
  return {
    close() {},
    ...Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [
      name,
      (
        request: Record<string, unknown>,
        metadata: Metadata,
        _options: { deadline: Date },
        callback: (error: ({ code?: number } & Error) | null, response?: unknown) => void,
      ) => handler(request, metadata, callback),
    ])),
  };
}

const action = {
  instanceId: "instance-1",
  namespace: "team/project",
  typeId: "review",
  version: "1",
  operationId: "operation-1",
  status: "admitted",
  createdAtMs: "1000",
  decidedAtMs: "1100",
};

test("ChiseiProjectionClient returns only bounded Action projection fields with server auth", async () => {
  let authorization: string[] = [];
  const client = new ChiseiProjectionClient(
    {
      ALDUNIS_CHISEI_ENDPOINT: "https://plane.example:50051",
      ALDUNIS_CHISEI_TOKEN: "secret-token",
    },
    ((service: string, endpoint: string, secure: boolean) => {
      assert.equal(service, "sekai");
      assert.equal(endpoint, "plane.example:50051");
      assert.equal(secure, true);
      return fixtureClient({
        listActionInstances(request, metadata, callback) {
          assert.deepEqual(request, {
            namespace: "team/project",
            typeId: "",
            status: "",
            limit: 25,
          });
          authorization = metadata.get("authorization") as string[];
          callback(null, {
            instances: [{
              ...action,
              parametersJson: "{\"secret\":\"not projected\"}",
              principal: "not-projected",
            }],
          });
        },
      }) as never;
    }) as never,
    () => 2_000,
  );
  const result = await client.listActions("project-1", "team/project");
  assert.equal(result.state, "live");
  assert.deepEqual(authorization, ["Bearer secret-token"]);
  assert.deepEqual(result.actions, [{
    instanceId: "instance-1",
    namespace: "team/project",
    typeId: "review",
    version: "1",
    operationId: "operation-1",
    status: "admitted",
    createdAt: "1970-01-01T00:00:01.000Z",
    decidedAt: "1970-01-01T00:00:01.100Z",
  }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|principal/);
});

test("ChiseiProjectionClient rejects non-loopback HTTP before creating a client", async () => {
  let factoryCalled = false;
  const client = new ChiseiProjectionClient(
    {
      ALDUNIS_CHISEI_ENDPOINT: "http://plane.example:50051",
      ALDUNIS_CHISEI_TOKEN: "secret-token",
    },
    (() => {
      factoryCalled = true;
      return fixtureClient({}) as never;
    }) as never,
  );
  await assert.rejects(
    () => client.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError
      && error.kind === "unconfigured"
      && /require HTTPS/.test(error.message),
  );
  assert.equal(factoryCalled, false);
});

test("ChiseiProjectionClient rejects non-loopback HTTP without a bearer token", async () => {
  let factoryCalled = false;
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://plane.example:50051" },
    (() => {
      factoryCalled = true;
      return fixtureClient({}) as never;
    }) as never,
  );
  await assert.rejects(
    () => client.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError && error.kind === "unconfigured",
  );
  assert.equal(factoryCalled, false);
});

test("ChiseiProjectionClient serves only recent in-memory data when the plane becomes unavailable", async () => {
  let calls = 0;
  let now = 10_000;
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    (() => fixtureClient({
      listActionInstances(_request, _metadata, callback) {
        calls += 1;
        if (calls === 1) callback(null, { instances: [action] });
        else callback(Object.assign(new Error("down"), { code: 14 }));
      },
    }) as never) as never,
    () => now,
  );
  assert.equal((await client.listActions("project-1", "team/project")).state, "live");
  now += 2_000;
  const stale = await client.listActions("project-1", "team/project");
  assert.equal(stale.state, "stale");
  assert.match(stale.warning ?? "", /recent in-memory projection/);
  now += 31_000;
  await assert.rejects(
    () => client.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError && error.kind === "unavailable",
  );
});

test("ChiseiProjectionClient fails closed on auth and namespace drift", async () => {
  const unauthorized = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    (() => fixtureClient({
      listActionInstances(_request, _metadata, callback) {
        callback(Object.assign(new Error("denied"), { code: 7 }));
      },
    }) as never) as never,
  );
  await assert.rejects(
    () => unauthorized.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError
      && error.kind === "unauthorized"
      && error.status === 403,
  );

  const drifted = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    (() => fixtureClient({
      listActionInstances(_request, _metadata, callback) {
        callback(null, { instances: [{ ...action, namespace: "other/project" }] });
      },
    }) as never) as never,
  );
  await assert.rejects(
    () => drifted.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError && error.kind === "incompatible",
  );
});

test("ChiseiProjectionClient rejects timestamps outside the JavaScript date range", async () => {
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    (() => fixtureClient({
      listActionInstances(_request, _metadata, callback) {
        callback(null, {
          instances: [{ ...action, createdAtMs: String(Number.MAX_SAFE_INTEGER) }],
        });
      },
    }) as never) as never,
  );
  await assert.rejects(
    () => client.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError
      && error.kind === "incompatible"
      && error.status === 502,
  );
});

test("ChiseiProjectionClient joins effect and receipt detail without returning raw receipt content", async () => {
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    ((service: string) => fixtureClient(service === "sekai" ? {
      getActionInstance(request, _metadata, callback) {
        assert.equal(request.namespace, "team/project");
        callback(null, { instance: action });
      },
      listActionEffects(request, _metadata, callback) {
        assert.equal(request.namespace, "team/project");
        callback(null, {
          effects: [{
            effectId: "effect-1",
            instanceId: action.instanceId,
            namespace: action.namespace,
            operationId: action.operationId,
            kind: "runtime_dispatch",
            status: "completed",
            lifecycleState: "completed",
            createdAtMs: "1200",
            updatedAtMs: "1300",
            payloadJson: "{\"task\":\"not projected\"}",
          }],
        });
      },
    } : {
      getOperationReceipt(_request, _metadata, callback) {
        callback(null, {
          receiptJson: "{\"events\":[{\"prompt\":\"not projected\"},{\"kind\":\"complete\"}]}",
          complete: true,
          missingSurfaces: [],
        });
      },
    }) as never) as never,
  );
  const result = await client.actionDetail("team/project", "instance-1");
  assert.equal(result.effects[0].kind, "runtime_dispatch");
  assert.equal(result.receipt.eventCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /task|prompt|not projected/);
});

test("ChiseiProjectionClient projects denied Actions without an operation", async () => {
  let secondaryLookup = false;
  const denied = { ...action, operationId: "", status: "denied" };
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    ((service: string) => {
      if (service === "chisei") secondaryLookup = true;
      return fixtureClient({
        listActionInstances(_request, _metadata, callback) {
          callback(null, { instances: [denied] });
        },
        getActionInstance(_request, _metadata, callback) {
          callback(null, { instance: denied });
        },
        listActionEffects() {
          secondaryLookup = true;
        },
      }) as never;
    }) as never,
  );
  const list = await client.listActions("project-1", "team/project");
  assert.equal(list.actions[0].operationId, null);
  const detail = await client.actionDetail("team/project", "instance-1");
  assert.deepEqual(detail.effects, []);
  assert.equal(detail.receipt, null);
  assert.equal(secondaryLookup, false);
});

test("ChiseiProjectionClient exposes a bounded operation receipt projection", async () => {
  const operationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    (() => fixtureClient({
      getOperationReceipt(request, _metadata, callback) {
        assert.equal(request.operationId, operationId);
        callback(null, {
          receiptJson: "{\"events\":[{},{}],\"prompt\":\"not projected\"}",
          complete: true,
          missingSurfaces: [],
        });
      },
    }) as never) as never,
  );
  assert.deepEqual(await client.operationReceipt(operationId), {
    operationId,
    complete: true,
    missingSurfaces: [],
    eventCount: 2,
  });
});

test("ChiseiProjectionClient reads only the authenticated sample-observation projection", async () => {
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    (() => fixtureClient({
      getSampleObservation(request, _metadata, callback) {
        assert.deepEqual(request, {
          requestId: "tenkai:outcome:v2:event-1",
          namespace: "team/project",
        });
        callback(null, {
          observation: {
            requestId: request.requestId,
            namespace: request.namespace,
            observationDigest: `sha256:${"a".repeat(64)}`,
            state: "recorded",
            observedAt: "1000",
            readAt: "2000",
            outputContent: "must not cross the boundary",
          },
        });
      },
    }) as never) as never,
  );
  assert.deepEqual(await client.sampleObservation("team/project", "tenkai:outcome:v2:event-1"), {
    requestId: "tenkai:outcome:v2:event-1",
    namespace: "team/project",
    observationDigest: `sha256:${"a".repeat(64)}`,
    state: "recorded",
    observedAt: "1970-01-01T00:00:01.000Z",
    readAt: "1970-01-01T00:00:02.000Z",
  });
});

test("ChiseiProjectionClient turns a missing sample observation into an explicit absence", async () => {
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    (() => fixtureClient({
      getSampleObservation(_request, _metadata, callback) {
        callback(Object.assign(new Error("not found"), { code: 5 }));
      },
    }) as never) as never,
  );
  assert.equal(await client.sampleObservation("team/project", "event-1"), null);
});
