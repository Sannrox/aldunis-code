import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SDK_CONTRACT_VERSION,
  SdkError,
  SekaiChiseiClient,
} from "@sannrox/sekai-chisei-sdk";
import {
  ChiseiClientError,
  ChiseiProjectionClient,
  type ChiseiSdkClient,
  type ChiseiSdkFactoryConfig,
} from "./chisei-client.ts";

type FixtureOptions = {
  namespace?: string;
  operationId?: string;
  requestId?: string;
  timeoutMs?: number;
};

type Handler = (
  request: Record<string, unknown>,
  options: FixtureOptions,
) => unknown | Promise<unknown>;

function fixtureClient(handlers: Record<string, Handler>): ChiseiSdkClient {
  return {
    raw: {
      async unary<T = unknown>(
        service: "sekai" | "chisei",
        method: string,
        request: Record<string, unknown>,
        options = {},
      ): Promise<T> {
        const handler = handlers[`${service}.${method}`] ?? handlers[method];
        if (!handler) throw new SdkError("unimplemented", `missing fixture RPC ${service}.${method}`);
        return await handler(request, options) as T;
      },
    },
    close() {},
  };
}

function fixtureFactory(
  handlers: Record<string, Handler>,
  onConfig?: (config: ChiseiSdkFactoryConfig) => void,
) {
  return async (config: ChiseiSdkFactoryConfig) => {
    onConfig?.(config);
    return fixtureClient(handlers);
  };
}

const action = {
  instance_id: "instance-1",
  namespace: "team/project",
  type_id: "review",
  version: "1",
  operation_id: "operation-1",
  status: "admitted",
  created_at_ms: "1000",
  decided_at_ms: "1100",
};

test("vendored SDK loads the pinned minimal Chisei read contract", async () => {
  assert.equal(SDK_CONTRACT_VERSION, "sekai.sdk-core-loop/v1");
  const client = await SekaiChiseiClient.connect({
    target: "http://127.0.0.1:50051",
    principal: "aldunis-code",
    protoRoot: fileURLToPath(new URL("../contracts/", import.meta.url)),
  });
  client.close();
});

test("ChiseiProjectionClient uses the server-owned SDK context and bounded Action projection", async () => {
  let config: ChiseiSdkFactoryConfig | undefined;
  let call: { request: Record<string, unknown>; options: FixtureOptions } | undefined;
  const client = new ChiseiProjectionClient(
    {
      ALDUNIS_CHISEI_ENDPOINT: "https://plane.example:50051",
      ALDUNIS_CHISEI_TOKEN: "secret-token",
    },
    fixtureFactory({
      "sekai.ListActionInstances": (request, options) => {
        call = { request, options };
        return {
          instances: [{
            ...action,
            parameters_json: "{\"secret\":\"not projected\"}",
            principal: "not-projected",
          }],
        };
      },
    }, (received) => { config = received; }),
    () => 2_000,
  );
  const result = await client.listActions("project-1", "team/project");
  assert.deepEqual(config, {
    target: "https://plane.example:50051",
    token: "secret-token",
    principal: "aldunis-code",
    namespace: "team/project",
    protoRoot: config?.protoRoot,
  });
  assert.ok(config?.protoRoot.endsWith("/contracts/"));
  assert.deepEqual(call?.request, {
    namespace: "team/project",
    type_id: "",
    status: "",
    limit: 25,
  });
  assert.equal(call?.options.namespace, "team/project");
  assert.equal(call?.options.timeoutMs, 5_000);
  assert.match(call?.options.requestId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(result.state, "live");
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

test("ChiseiProjectionClient rejects non-loopback HTTP before creating an SDK client", async () => {
  let factoryCalled = false;
  const client = new ChiseiProjectionClient(
    {
      ALDUNIS_CHISEI_ENDPOINT: "http://plane.example:50051",
      ALDUNIS_CHISEI_TOKEN: "secret-token",
    },
    async () => {
      factoryCalled = true;
      return fixtureClient({});
    },
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
    async () => {
      factoryCalled = true;
      return fixtureClient({});
    },
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
    fixtureFactory({
      "sekai.ListActionInstances": () => {
        calls += 1;
        if (calls === 1) return { instances: [action] };
        throw new SdkError("unavailable", "plane down");
      },
    }),
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

test("ChiseiProjectionClient fails closed on SDK authorization errors and namespace drift", async () => {
  const unauthorized = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    fixtureFactory({
      "sekai.ListActionInstances": () => {
        throw new SdkError("permission_denied", "denied");
      },
    }),
  );
  await assert.rejects(
    () => unauthorized.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError
      && error.kind === "unauthorized"
      && error.status === 403,
  );

  const drifted = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    fixtureFactory({
      "sekai.ListActionInstances": () => ({
        instances: [{ ...action, namespace: "other/project" }],
      }),
    }),
  );
  await assert.rejects(
    () => drifted.listActions("project-1", "team/project"),
    (error: unknown) => error instanceof ChiseiClientError && error.kind === "incompatible",
  );
});

test("ChiseiProjectionClient rejects timestamps outside the JavaScript date range", async () => {
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    fixtureFactory({
      "sekai.ListActionInstances": () => ({
        instances: [{ ...action, created_at_ms: String(Number.MAX_SAFE_INTEGER) }],
      }),
    }),
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
    fixtureFactory({
      "sekai.GetActionInstance": (request) => {
        assert.equal(request.namespace, "team/project");
        return { instance: action };
      },
      "sekai.ListActionEffects": (request) => {
        assert.equal(request.namespace, "team/project");
        return {
          effects: [{
            effect_id: "effect-1",
            instance_id: action.instance_id,
            namespace: action.namespace,
            operation_id: action.operation_id,
            kind: "runtime_dispatch",
            status: "completed",
            lifecycle_state: "completed",
            created_at_ms: "1200",
            updated_at_ms: "1300",
            payload_json: "{\"task\":\"not projected\"}",
          }],
        };
      },
      "chisei.GetOperationReceipt": (_request, options) => {
        assert.equal(options.operationId, "operation-1");
        return {
          receipt_json: "{\"events\":[{\"prompt\":\"not projected\"},{\"kind\":\"complete\"}]}",
          complete: true,
          missing_surfaces: [],
        };
      },
    }),
  );
  const result = await client.actionDetail("team/project", "instance-1");
  assert.equal(result.effects[0].kind, "runtime_dispatch");
  assert.equal(result.receipt?.eventCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /task|prompt|not projected/);
});

test("ChiseiProjectionClient does not read effects or receipts for denied Actions", async () => {
  let secondaryLookup = false;
  const denied = { ...action, operation_id: "", status: "denied" };
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    fixtureFactory({
      "sekai.ListActionInstances": () => ({ instances: [denied] }),
      "sekai.GetActionInstance": () => ({ instance: denied }),
      "sekai.ListActionEffects": () => {
        secondaryLookup = true;
        return { effects: [] };
      },
      "chisei.GetOperationReceipt": () => {
        secondaryLookup = true;
        return {};
      },
    }),
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
  let request: Record<string, unknown> | undefined;
  let options: FixtureOptions | undefined;
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    fixtureFactory({
      "chisei.GetOperationReceipt": (received, receivedOptions) => {
        request = received;
        options = receivedOptions;
        return {
          receipt_json: "{\"events\":[{},{}],\"prompt\":\"not projected\"}",
          complete: true,
          missing_surfaces: [],
        };
      },
    }),
  );
  assert.deepEqual(await client.operationReceipt(operationId), {
    operationId,
    complete: true,
    missingSurfaces: [],
    eventCount: 2,
  });
  assert.equal(request?.operation_id, operationId);
  assert.equal(request?.caller_scope, "aldunis-code");
  assert.equal(request?.attempt, 1);
  assert.equal(options?.operationId, operationId);
});

test("ChiseiProjectionClient reads only the authenticated sample-observation projection", async () => {
  const client = new ChiseiProjectionClient(
    { ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051" },
    fixtureFactory({
      "chisei.GetSampleObservation": (request) => {
        assert.deepEqual(request, {
          request_id: "tenkai:outcome:v2:event-1",
          namespace: "team/project",
        });
        return {
          observation: {
            request_id: request.request_id,
            namespace: request.namespace,
            observation_digest: `sha256:${"a".repeat(64)}`,
            state: "recorded",
            observed_at: "1000",
            read_at: "2000",
            output_content: "must not cross the boundary",
          },
        };
      },
    }),
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
    fixtureFactory({
      "chisei.GetSampleObservation": () => {
        throw new SdkError("not_found", "not found");
      },
    }),
  );
  assert.equal(await client.sampleObservation("team/project", "event-1"), null);
});
