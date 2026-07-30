import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type Client,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_ACTIONS = 50;
const MAX_EFFECTS = 50;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;

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

type RpcCallback = (error: ServiceError | null, response?: unknown) => void;
type RpcClient = Client & Record<string, (
  request: Record<string, unknown>,
  metadata: Metadata,
  options: { deadline: Date },
  callback: RpcCallback,
) => void>;

type ClientFactory = (
  service: "sekai" | "chisei",
  endpoint: string,
  secure: boolean,
) => RpcClient;

export class ChiseiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "unconfigured" | "unauthorized" | "unavailable" | "incompatible",
  ) {
    super(message);
  }
}

function configuredEndpoint(
  env: NodeJS.ProcessEnv,
): { target: string; secure: boolean; loopback: boolean } {
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
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.host
  ) {
    throw new ChiseiClientError("The configured Chisei endpoint is invalid.", 503, "unconfigured");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  return {
    target: url.host,
    secure: url.protocol === "https:",
    loopback: hostname === "127.0.0.1" || hostname === "::1",
  };
}

function defaultClientFactory(
  service: "sekai" | "chisei",
  endpoint: string,
  secure: boolean,
): RpcClient {
  const proto = service === "sekai"
    ? "../contracts/sekai-action-read.proto"
    : "../contracts/chisei-operation-read.proto";
  const definition = loadSync(fileURLToPath(new URL(proto, import.meta.url)), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const loaded = loadPackageDefinition(definition) as unknown as Record<
    string,
    Record<string, new (target: string, credentials: ReturnType<typeof credentials.createInsecure>) => RpcClient>
  >;
  const packageName = service === "sekai" ? "sekai" : "chisei";
  const constructorName = service === "sekai" ? "SekaiService" : "ChiseiService";
  const Constructor = loaded[packageName]?.[constructorName];
  if (!Constructor) {
    throw new ChiseiClientError("The Chisei read contract is unavailable.", 502, "incompatible");
  }
  return new Constructor(
    endpoint,
    secure ? credentials.createSsl() : credentials.createInsecure(),
  );
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
  if (nullable && (value === undefined || value === null || value === "0" || value === 0)) return null;
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
  const namespace = boundedText(item.namespace, "Action namespace", 200);
  if (namespace !== expectedNamespace) {
    throw new ChiseiClientError("Chisei returned an Action outside the configured namespace.", 502, "incompatible");
  }
  return {
    instanceId: boundedText(item.instanceId, "Action id", 200),
    namespace,
    typeId: boundedText(item.typeId, "Action type", 200),
    version: boundedText(item.version, "Action version", 100),
    operationId: optionalBoundedText(item.operationId, "operation id", 200),
    status: boundedText(item.status, "Action status", 50),
    createdAt: timestamp(item.createdAtMs, "Action creation time")!,
    decidedAt: timestamp(item.decidedAtMs, "Action decision time", true),
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
    boundedText(item.namespace, "effect namespace", 200) !== action.namespace
    || boundedText(item.instanceId, "effect Action id", 200) !== action.instanceId
    || boundedText(item.operationId, "effect operation id", 200) !== action.operationId
  ) {
    throw new ChiseiClientError("Chisei returned an effect outside the selected Action.", 502, "incompatible");
  }
  return {
    effectId: boundedText(item.effectId, "effect id", 200),
    instanceId: action.instanceId,
    operationId: action.operationId,
    kind: boundedText(item.kind, "effect kind", 100),
    status: boundedText(item.status, "effect status", 50),
    lifecycleState: boundedText(item.lifecycleState ?? item.status, "effect lifecycle", 50),
    createdAt: timestamp(item.createdAtMs, "effect creation time")!,
    updatedAt: timestamp(item.updatedAtMs, "effect update time")!,
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

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factory: ClientFactory = defaultClientFactory,
    private readonly now: () => number = Date.now,
  ) {}

  async #call(
    service: "sekai" | "chisei",
    method: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const endpoint = configuredEndpoint(this.env);
    const token = this.env.ALDUNIS_CHISEI_TOKEN?.trim();
    if (!endpoint.secure && !endpoint.loopback) {
      throw new ChiseiClientError(
        "Chisei connections require HTTPS outside loopback.",
        503,
        "unconfigured",
      );
    }
    const client = this.factory(service, endpoint.target, endpoint.secure);
    const metadata = new Metadata();
    if (token) metadata.set("authorization", `Bearer ${token}`);
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const rpc = client[method];
        if (typeof rpc !== "function") {
          reject(new ChiseiClientError("The Chisei read contract is unavailable.", 502, "incompatible"));
          return;
        }
        rpc.call(
          client,
          request,
          metadata,
          { deadline: new Date(this.now() + DEFAULT_TIMEOUT_MS) },
          (error, response) => {
            if (error) reject(error);
            else if (!response || typeof response !== "object" || Array.isArray(response)) {
              reject(new ChiseiClientError("Chisei returned an incompatible response.", 502, "incompatible"));
            } else resolve(response as Record<string, unknown>);
          },
        );
      });
    } catch (error) {
      if (error instanceof ChiseiClientError) throw error;
      const code = (error as { code?: number }).code;
      if (code === 16 || code === 7) {
        throw new ChiseiClientError("Chisei denied this projection.", 403, "unauthorized");
      }
      if (code === 12 || code === 3) {
        throw new ChiseiClientError("The configured Chisei contract is incompatible.", 502, "incompatible");
      }
      throw new ChiseiClientError("Chisei is unavailable.", 503, "unavailable");
    } finally {
      client.close();
    }
  }

  async listActions(
    projectId: string,
    namespace: string,
    filters: { typeId?: string; status?: string; limit?: number } = {},
  ): Promise<ChiseiActionListProjection> {
    const limit = Math.max(1, Math.min(MAX_ACTIONS, filters.limit ?? 25));
    const cacheKey = `${projectId}\n${namespace}\n${filters.typeId ?? ""}\n${filters.status ?? ""}\n${limit}`;
    for (const [key, value] of this.#cache) {
      if (this.now() - Date.parse(value.fetchedAt) > CACHE_TTL_MS) this.#cache.delete(key);
    }
    const existing = this.#cache.get(cacheKey);
    try {
      const response = await this.#call("sekai", "listActionInstances", {
        namespace,
        typeId: filters.typeId ?? "",
        status: filters.status ?? "",
        limit,
      });
      if (!Array.isArray(response.instances) || response.instances.length > limit) {
        throw new ChiseiClientError("Chisei returned an incompatible Action list.", 502, "incompatible");
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
        this.#cache.delete(oldest);
      }
      const timeout = setTimeout(() => {
        if (this.#cache.get(cacheKey)?.fetchedAt === fetchedAt) this.#cache.delete(cacheKey);
      }, CACHE_TTL_MS);
      timeout.unref();
      return result;
    } catch (error) {
      if (
        existing
        && this.now() - Date.parse(existing.fetchedAt) <= CACHE_TTL_MS
        && error instanceof ChiseiClientError
        && error.kind === "unavailable"
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

  async actionDetail(namespace: string, instanceId: string): Promise<ChiseiActionDetailProjection> {
    const actionResponse = await this.#call("sekai", "getActionInstance", {
      instanceId,
      namespace,
      idempotencyKey: "",
    });
    const action = actionProjection(actionResponse.instance, namespace);
    if (action.instanceId !== instanceId) {
      throw new ChiseiClientError("Chisei returned a different Action.", 502, "incompatible");
    }
    if (!action.operationId) {
      return { action, effects: [], receipt: null };
    }
    const [effectResponse, receiptResponse] = await Promise.all([
      this.#call("sekai", "listActionEffects", {
        instanceId,
        namespace,
        kind: "",
        status: "",
        limit: MAX_EFFECTS,
      }),
      this.#call("chisei", "getOperationReceipt", {
        operationId: action.operationId,
        requestId: randomUUID(),
        callerScope: "aldunis-code",
        attempt: 1,
      }),
    ]);
    if (!Array.isArray(effectResponse.effects) || effectResponse.effects.length > MAX_EFFECTS) {
      throw new ChiseiClientError("Chisei returned an incompatible effect list.", 502, "incompatible");
    }
    const missing = receiptResponse.missingSurfaces;
    if (
      typeof receiptResponse.complete !== "boolean"
      || !Array.isArray(missing)
      || missing.length > 50
      || missing.some((item) => typeof item !== "string" || item.length > 200)
    ) {
      throw new ChiseiClientError("Chisei returned an incompatible operation receipt.", 502, "incompatible");
    }
    return {
      action,
      effects: effectResponse.effects.map((item) => effectProjection(item, action)),
      receipt: {
        operationId: action.operationId,
        complete: receiptResponse.complete,
        missingSurfaces: missing as string[],
        eventCount: eventCount(receiptResponse.receiptJson),
      },
    };
  }

  async operationReceipt(operationId: string): Promise<ChiseiReceiptProjection> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)
    ) {
      throw new ChiseiClientError("The Chisei operation identity is incompatible.", 502, "incompatible");
    }
    const response = await this.#call("chisei", "getOperationReceipt", {
      operationId,
      requestId: randomUUID(),
      callerScope: "aldunis-code",
      attempt: 1,
    });
    const missing = response.missingSurfaces;
    if (
      typeof response.complete !== "boolean"
      || !Array.isArray(missing)
      || missing.length > 50
      || missing.some((item) => typeof item !== "string" || item.length > 200)
    ) {
      throw new ChiseiClientError("Chisei returned an incompatible operation receipt.", 502, "incompatible");
    }
    return {
      operationId,
      complete: response.complete,
      missingSurfaces: missing as string[],
      eventCount: eventCount(response.receiptJson),
    };
  }
}
