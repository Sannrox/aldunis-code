import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SdkError, SekaiChiseiClient } from "@sannrox/sekai-chisei-sdk";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_ACTIONS = 50;
const MAX_EFFECTS = 50;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CHISEI_PRINCIPAL = "aldunis-code";
const CHISEI_PROTO_ROOT = fileURLToPath(new URL("../contracts/", import.meta.url));

interface ChiseiCacheTimer {
  unref(): void;
}

interface ChiseiCacheTimers {
  setTimeout(callback: () => void, delayMs: number): ChiseiCacheTimer;
  clearTimeout(timer: ChiseiCacheTimer): void;
}

const defaultCacheTimers: ChiseiCacheTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export interface ChiseiActionProjection {
  instanceId: string;
  namespace: string;
  typeId: string;
  version: string;
  operationId: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface ChiseiEffectProjection {
  effectId: string;
  instanceId: string;
  operationId: string;
  kind: string;
  status: string;
  lifecycleState: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChiseiReceiptProjection {
  operationId: string;
  complete: boolean;
  missingSurfaces: string[];
  eventCount: number | null;
}

export interface ChiseiSampleObservationProjection {
  requestId: string;
  namespace: string;
  observationDigest: string;
  state: string;
  observedAt: string;
  readAt: string;
}

export interface ChiseiActionDetailProjection {
  action: ChiseiActionProjection;
  effects: ChiseiEffectProjection[];
  receipt: ChiseiReceiptProjection | null;
}

export interface ChiseiActionListProjection {
  state: "live" | "stale";
  fetchedAt: string;
  actions: ChiseiActionProjection[];
  warning: string | null;
}

export interface ChiseiSdkClient {
  raw: {
    unary<T = unknown>(
      service: "sekai" | "chisei",
      method: string,
      request: Record<string, unknown>,
      options?: {
        namespace?: string;
        operationId?: string;
        requestId?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
      },
    ): Promise<T>;
  };
  close(): void;
}

export interface ChiseiSdkFactoryConfig {
  target: string;
  token?: string;
  principal: string;
  namespace: string;
  protoRoot: string;
}

export type ChiseiSdkFactory = (config: ChiseiSdkFactoryConfig) => Promise<ChiseiSdkClient>;

export class ChiseiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "unconfigured" | "unauthorized" | "unavailable" | "incompatible" | "not_found",
  ) {
    super(message);
  }
}

function configuredEndpoint(env: NodeJS.ProcessEnv): {
  target: string;
  secure: boolean;
  loopback: boolean;
} {
  const raw = env.ALDUNIS_CHISEI_ENDPOINT?.trim();
  if (!raw) {
    throw new ChiseiClientError("Chisei is not configured.", 503, "unconfigured");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChiseiClientError("The configured Chisei endpoint is invalid.", 503, "unconfigured");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.host
  ) {
    throw new ChiseiClientError("The configured Chisei endpoint is invalid.", 503, "unconfigured");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  return {
    target: raw,
    secure: url.protocol === "https:",
    loopback: hostname === "127.0.0.1" || hostname === "::1",
  };
}

const defaultSdkFactory: ChiseiSdkFactory = async (config) =>
  SekaiChiseiClient.connect({
    target: config.target,
    token: config.token,
    principal: config.principal,
    namespace: config.namespace,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    protoRoot: config.protoRoot,
  });

function responseField(
  value: Record<string, unknown>,
  snakeCase: string,
  camelCase: string,
): unknown {
  return value[snakeCase] === undefined ? value[camelCase] : value[snakeCase];
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new ChiseiClientError(`Chisei returned an incompatible ${field}.`, 502, "incompatible");
  }
  return value;
}

function optionalBoundedText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedText(value, field, max);
}

function timestamp(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === "0" || value === 0))
    return null;
  const millis = typeof value === "string" ? Number(value) : value;
  if (typeof millis !== "number" || !Number.isSafeInteger(millis) || millis <= 0) {
    throw new ChiseiClientError(`Chisei returned an incompatible ${field}.`, 502, "incompatible");
  }
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) {
    throw new ChiseiClientError(`Chisei returned an incompatible ${field}.`, 502, "incompatible");
  }
  return date.toISOString();
}

function actionProjection(value: unknown, expectedNamespace: string): ChiseiActionProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChiseiClientError("Chisei returned an incompatible Action.", 502, "incompatible");
  }
  const item = value as Record<string, unknown>;
  const namespace = boundedText(
    responseField(item, "namespace", "namespace"),
    "Action namespace",
    200,
  );
  if (namespace !== expectedNamespace) {
    throw new ChiseiClientError(
      "Chisei returned an Action outside the configured namespace.",
      502,
      "incompatible",
    );
  }
  return {
    instanceId: boundedText(responseField(item, "instance_id", "instanceId"), "Action id", 200),
    namespace,
    typeId: boundedText(responseField(item, "type_id", "typeId"), "Action type", 200),
    version: boundedText(responseField(item, "version", "version"), "Action version", 100),
    operationId: optionalBoundedText(
      responseField(item, "operation_id", "operationId"),
      "operation id",
      200,
    ),
    status: boundedText(responseField(item, "status", "status"), "Action status", 50),
    createdAt: timestamp(
      responseField(item, "created_at_ms", "createdAtMs"),
      "Action creation time",
    )!,
    decidedAt: timestamp(
      responseField(item, "decided_at_ms", "decidedAtMs"),
      "Action decision time",
      true,
    ),
  };
}

function effectProjection(
  value: unknown,
  action: ChiseiActionProjection & { operationId: string },
): ChiseiEffectProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChiseiClientError("Chisei returned an incompatible effect.", 502, "incompatible");
  }
  const item = value as Record<string, unknown>;
  if (
    boundedText(responseField(item, "namespace", "namespace"), "effect namespace", 200) !==
      action.namespace ||
    boundedText(responseField(item, "instance_id", "instanceId"), "effect Action id", 200) !==
      action.instanceId ||
    boundedText(responseField(item, "operation_id", "operationId"), "effect operation id", 200) !==
      action.operationId
  ) {
    throw new ChiseiClientError(
      "Chisei returned an effect outside the selected Action.",
      502,
      "incompatible",
    );
  }
  return {
    effectId: boundedText(responseField(item, "effect_id", "effectId"), "effect id", 200),
    instanceId: action.instanceId,
    operationId: action.operationId,
    kind: boundedText(responseField(item, "kind", "kind"), "effect kind", 100),
    status: boundedText(responseField(item, "status", "status"), "effect status", 50),
    lifecycleState: boundedText(
      responseField(item, "lifecycle_state", "lifecycleState") ??
        responseField(item, "status", "status"),
      "effect lifecycle",
      50,
    ),
    createdAt: timestamp(
      responseField(item, "created_at_ms", "createdAtMs"),
      "effect creation time",
    )!,
    updatedAt: timestamp(
      responseField(item, "updated_at_ms", "updatedAtMs"),
      "effect update time",
    )!,
  };
}

function eventCount(receiptJson: unknown): number | null {
  if (typeof receiptJson !== "string" || receiptJson.length > 2_000_000) return null;
  try {
    const parsed = JSON.parse(receiptJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ["events", "timeline", "entries"]) {
      if (Array.isArray(record[key])) return record[key].length;
    }
  } catch {
    return null;
  }
  return null;
}

export class ChiseiProjectionClient {
  readonly #cache = new Map<string, ChiseiActionListProjection>();
  readonly #cacheExpiryTimers = new Map<string, ChiseiCacheTimer>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factory: ChiseiSdkFactory = defaultSdkFactory,
    private readonly now: () => number = Date.now,
    private readonly cacheTimers: ChiseiCacheTimers = defaultCacheTimers,
  ) {}

  #deleteCachedProjection(key: string): void {
    this.#cache.delete(key);
    const timer = this.#cacheExpiryTimers.get(key);
    if (!timer) return;
    this.cacheTimers.clearTimeout(timer);
    this.#cacheExpiryTimers.delete(key);
  }

  #scheduleCacheExpiry(key: string, fetchedAt: string): void {
    const previous = this.#cacheExpiryTimers.get(key);
    if (previous) this.cacheTimers.clearTimeout(previous);
    const timer = this.cacheTimers.setTimeout(() => {
      if (this.#cacheExpiryTimers.get(key) !== timer) return;
      this.#cacheExpiryTimers.delete(key);
      if (this.#cache.get(key)?.fetchedAt === fetchedAt) this.#cache.delete(key);
    }, CACHE_TTL_MS);
    timer.unref();
    this.#cacheExpiryTimers.set(key, timer);
  }

  async #call(
    service: "sekai" | "chisei",
    method: string,
    request: Record<string, unknown>,
    context: { namespace: string; operationId?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const endpoint = configuredEndpoint(this.env);
    const token = this.env.ALDUNIS_CHISEI_TOKEN?.trim();
    if (!endpoint.secure && !endpoint.loopback) {
      throw new ChiseiClientError(
        "Chisei connections require HTTPS outside loopback.",
        503,
        "unconfigured",
      );
    }
    let client: ChiseiSdkClient | undefined;
    try {
      client = await this.factory({
        target: endpoint.target,
        token,
        principal: CHISEI_PRINCIPAL,
        namespace: context.namespace,
        protoRoot: CHISEI_PROTO_ROOT,
      });
      signal?.throwIfAborted();
      const response = await client.raw.unary<Record<string, unknown>>(service, method, request, {
        namespace: context.namespace,
        operationId: context.operationId,
        requestId: randomUUID(),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal,
      });
      signal?.throwIfAborted();
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new ChiseiClientError(
          "Chisei returned an incompatible response.",
          502,
          "incompatible",
        );
      }
      return response;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ChiseiClientError) throw error;
      const code =
        error instanceof SdkError ? error.code : (error as { code?: string | number }).code;
      if (code === "unauthenticated" || code === "permission_denied" || code === 16 || code === 7) {
        throw new ChiseiClientError("Chisei denied this projection.", 403, "unauthorized");
      }
      if (code === "not_found" || code === 5) {
        throw new ChiseiClientError("The Chisei projection was not found.", 404, "not_found");
      }
      if (
        code === "invalid_argument" ||
        code === "failed_precondition" ||
        code === "unimplemented" ||
        code === 12 ||
        code === 3 ||
        (error instanceof Error && /contract|proto|service definition/i.test(error.message))
      ) {
        throw new ChiseiClientError(
          "The configured Chisei contract is incompatible.",
          502,
          "incompatible",
        );
      }
      throw new ChiseiClientError("Chisei is unavailable.", 503, "unavailable");
    } finally {
      client?.close();
    }
  }

  async listActions(
    projectId: string,
    namespace: string,
    filters: { typeId?: string; status?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ChiseiActionListProjection> {
    signal?.throwIfAborted();
    const limit = Math.max(1, Math.min(MAX_ACTIONS, filters.limit ?? 25));
    const cacheKey = `${projectId}\n${namespace}\n${filters.typeId ?? ""}\n${filters.status ?? ""}\n${limit}`;
    for (const [key, value] of this.#cache) {
      if (this.now() - Date.parse(value.fetchedAt) > CACHE_TTL_MS) {
        this.#deleteCachedProjection(key);
      }
    }
    const existing = this.#cache.get(cacheKey);
    try {
      const response = await this.#call(
        "sekai",
        "ListActionInstances",
        {
          namespace,
          type_id: filters.typeId ?? "",
          status: filters.status ?? "",
          limit,
        },
        { namespace },
        signal,
      );
      if (!Array.isArray(response.instances) || response.instances.length > limit) {
        throw new ChiseiClientError(
          "Chisei returned an incompatible Action list.",
          502,
          "incompatible",
        );
      }
      const fetchedAt = new Date(this.now()).toISOString();
      const result: ChiseiActionListProjection = {
        state: "live",
        fetchedAt,
        actions: response.instances.map((item) => actionProjection(item, namespace)),
        warning: null,
      };
      this.#cache.set(cacheKey, result);
      while (this.#cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.#cache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.#deleteCachedProjection(oldest);
      }
      this.#scheduleCacheExpiry(cacheKey, fetchedAt);
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        existing &&
        this.now() - Date.parse(existing.fetchedAt) <= CACHE_TTL_MS &&
        error instanceof ChiseiClientError &&
        error.kind === "unavailable"
      ) {
        return {
          ...existing,
          state: "stale",
          warning: "Chisei is unavailable. Showing a recent in-memory projection.",
        };
      }
      throw error;
    }
  }

  async actionDetail(
    namespace: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<ChiseiActionDetailProjection> {
    const actionResponse = await this.#call(
      "sekai",
      "GetActionInstance",
      {
        instance_id: instanceId,
        namespace,
        idempotency_key: "",
      },
      { namespace },
      signal,
    );
    const action = actionProjection(actionResponse.instance, namespace);
    if (action.instanceId !== instanceId) {
      throw new ChiseiClientError("Chisei returned a different Action.", 502, "incompatible");
    }
    if (!action.operationId) {
      return { action, effects: [], receipt: null };
    }
    const [effectResponse, receiptResponse] = await Promise.all([
      this.#call(
        "sekai",
        "ListActionEffects",
        {
          instance_id: instanceId,
          namespace,
          kind: "",
          status: "",
          limit: MAX_EFFECTS,
        },
        { namespace },
        signal,
      ),
      this.#call(
        "chisei",
        "GetOperationReceipt",
        {
          operation_id: action.operationId,
          request_id: randomUUID(),
          caller_scope: "aldunis-code",
          attempt: 1,
        },
        { namespace, operationId: action.operationId },
        signal,
      ),
    ]);
    if (!Array.isArray(effectResponse.effects) || effectResponse.effects.length > MAX_EFFECTS) {
      throw new ChiseiClientError(
        "Chisei returned an incompatible effect list.",
        502,
        "incompatible",
      );
    }
    const missing = responseField(receiptResponse, "missing_surfaces", "missingSurfaces");
    if (
      typeof responseField(receiptResponse, "complete", "complete") !== "boolean" ||
      !Array.isArray(missing) ||
      missing.length > 50 ||
      missing.some((item) => typeof item !== "string" || item.length > 200)
    ) {
      throw new ChiseiClientError(
        "Chisei returned an incompatible operation receipt.",
        502,
        "incompatible",
      );
    }
    return {
      action,
      effects: effectResponse.effects.map((item) => effectProjection(item, action)),
      receipt: {
        operationId: action.operationId,
        complete: responseField(receiptResponse, "complete", "complete") as boolean,
        missingSurfaces: missing as string[],
        eventCount: eventCount(responseField(receiptResponse, "receipt_json", "receiptJson")),
      },
    };
  }

  async operationReceipt(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ChiseiReceiptProjection> {
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new ChiseiClientError(
        "The Chisei operation identity is incompatible.",
        502,
        "incompatible",
      );
    }
    const response = await this.#call(
      "chisei",
      "GetOperationReceipt",
      {
        operation_id: operationId,
        request_id: randomUUID(),
        caller_scope: "aldunis-code",
        attempt: 1,
      },
      { namespace: "", operationId },
      signal,
    );
    const missing = responseField(response, "missing_surfaces", "missingSurfaces");
    const complete = responseField(response, "complete", "complete");
    if (
      typeof complete !== "boolean" ||
      !Array.isArray(missing) ||
      missing.length > 50 ||
      missing.some((item) => typeof item !== "string" || item.length > 200)
    ) {
      throw new ChiseiClientError(
        "Chisei returned an incompatible operation receipt.",
        502,
        "incompatible",
      );
    }
    return {
      operationId,
      complete,
      missingSurfaces: missing as string[],
      eventCount: eventCount(responseField(response, "receipt_json", "receiptJson")),
    };
  }

  async sampleObservation(
    namespace: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ChiseiSampleObservationProjection | null> {
    signal?.throwIfAborted();
    if (
      typeof namespace !== "string" ||
      !namespace ||
      namespace.length > 200 ||
      namespace.includes("\0") ||
      typeof requestId !== "string" ||
      !requestId ||
      requestId.length > 512 ||
      requestId.includes("\0")
    ) {
      throw new ChiseiClientError(
        "The Chisei observation identity is incompatible.",
        502,
        "incompatible",
      );
    }
    let response: Record<string, unknown>;
    try {
      response = await this.#call(
        "chisei",
        "GetSampleObservation",
        {
          request_id: requestId,
          namespace,
        },
        { namespace },
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ChiseiClientError && error.kind === "not_found") return null;
      throw error;
    }
    const value = response.observation;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ChiseiClientError(
        "Chisei returned an incompatible observation projection.",
        502,
        "incompatible",
      );
    }
    const observation = value as Record<string, unknown>;
    const returnedRequestId = boundedText(
      responseField(observation, "request_id", "requestId"),
      "observation request id",
      512,
    );
    const returnedNamespace = boundedText(
      responseField(observation, "namespace", "namespace"),
      "observation namespace",
      200,
    );
    if (returnedRequestId !== requestId || returnedNamespace !== namespace) {
      throw new ChiseiClientError(
        "Chisei returned an observation outside the requested identity.",
        502,
        "incompatible",
      );
    }
    const observationDigest = boundedText(
      responseField(observation, "observation_digest", "observationDigest"),
      "observation digest",
      71,
    );
    if (!SHA256.test(observationDigest)) {
      throw new ChiseiClientError(
        "Chisei returned an incompatible observation digest.",
        502,
        "incompatible",
      );
    }
    return {
      requestId: returnedRequestId,
      namespace: returnedNamespace,
      observationDigest,
      state: boundedText(responseField(observation, "state", "state"), "observation state", 50),
      observedAt: timestamp(
        responseField(observation, "observed_at", "observedAt"),
        "observation time",
      )!,
      readAt: timestamp(responseField(observation, "read_at", "readAt"), "observation read time")!,
    };
  }
}
