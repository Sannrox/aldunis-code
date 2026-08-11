import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

const PAIRING_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const PROOF_CLOCK_SKEW_MS = 60_000;
const REPLAY_TTL_MS = 2 * PROOF_CLOCK_SKEW_MS;
export const MAX_REMOTE_PROOF_REPLAY_ENTRIES = 10_000;

interface PairingGrant {
  id: string;
  digest: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

interface RemoteSession {
  id: string;
  tokenDigest: string;
  label: string;
  publicKey: JsonWebKey;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface RemoteAuthState {
  schemaVersion: 1;
  hostId: string;
  pairingGrants: PairingGrant[];
  sessions: RemoteSession[];
}

export interface PairingResult {
  hostId: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export class RemoteAuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

export function assertRemoteProofNotReplayed(
  replay: Map<string, number>,
  key: string,
  now = Date.now(),
): void {
  const expiresAt = replay.get(key);
  if (expiresAt === undefined) return;
  if (expiresAt <= now) {
    replay.delete(key);
    return;
  }
  throw new RemoteAuthError("The remote device proof was replayed.");
}

export function assertRemoteProofReplayCapacity(
  replay: Map<string, number>,
  now = Date.now(),
  limit = MAX_REMOTE_PROOF_REPLAY_ENTRIES,
): void {
  if (replay.size < limit) return;
  // Every entry uses the same TTL and Map preserves insertion order. Avoid a
  // full scan while the oldest evidence is still live; capacity rejects remain
  // constant-time even under a sustained authenticated request flood.
  const oldestExpiry = replay.values().next().value;
  if (oldestExpiry !== undefined && oldestExpiry > now) {
    throw new RemoteAuthError("Remote device proof replay protection is at capacity.", 503);
  }
  for (const [candidate, expires] of replay) {
    if (expires <= now) replay.delete(candidate);
  }
  if (replay.size >= limit) {
    throw new RemoteAuthError("Remote device proof replay protection is at capacity.", 503);
  }
}

export function retainRemoteProofReplay(
  replay: Map<string, number>,
  key: string,
  expiresAt: number,
  now = Date.now(),
  limit = MAX_REMOTE_PROOF_REPLAY_ENTRIES,
): void {
  assertRemoteProofNotReplayed(replay, key, now);
  assertRemoteProofReplayCapacity(replay, now, limit);
  replay.set(key, expiresAt);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function emptyState(): RemoteAuthState {
  return {
    schemaVersion: 1,
    hostId: randomUUID(),
    pairingGrants: [],
    sessions: [],
  };
}

function isP256PublicKey(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string" &&
    key.d === undefined
  );
}

export class RemoteAuth {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #allowLoopbackHttp: boolean;
  #state: RemoteAuthState | null = null;
  #writeQueue: Promise<void> = Promise.resolve();
  #mutationQueue: Promise<void> = Promise.resolve();
  readonly #replay = new Map<string, number>();

  constructor(
    readonly directory: string,
    options: { allowLoopbackHttp?: boolean } = {},
  ) {
    this.#path = join(directory, "remote-auth.v1.json");
    this.#lockPath = join(directory, "remote-auth.v1.lock");
    this.#allowLoopbackHttp = options.allowLoopbackHttp === true;
  }

  async #load(): Promise<RemoteAuthState> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.#path, "utf8")) as RemoteAuthState;
      if (
        value.schemaVersion !== 1 ||
        typeof value.hostId !== "string" ||
        !Array.isArray(value.pairingGrants) ||
        !Array.isArray(value.sessions)
      ) {
        throw new Error("incompatible");
      }
      this.#state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RemoteAuthError("Remote access state is corrupt or incompatible.", 500);
      }
      this.#state = emptyState();
      await this.#save();
    }
    return this.#state;
  }

  async #save(): Promise<void> {
    const state = this.#state;
    if (!state) return;
    this.#writeQueue = this.#writeQueue.then(async () => {
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#path);
    });
    await this.#writeQueue;
  }

  async #mutate<T>(operation: (state: RemoteAuthState) => Promise<T> | T): Promise<T> {
    const previous = this.#mutationQueue;
    let release = () => undefined;
    this.#mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let lock: Awaited<ReturnType<typeof open>> | null = null;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          lock = await open(this.#lockPath, "wx", 0o600);
          await lock.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const lockState = await stat(this.#lockPath);
            if (Date.now() - lockState.mtimeMs > 30_000) {
              await rm(this.#lockPath, { force: true });
              continue;
            }
          } catch (stateError) {
            if ((stateError as NodeJS.ErrnoException).code !== "ENOENT") throw stateError;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (!lock) throw new RemoteAuthError("Remote access state is busy.", 503);
      const state = await this.#load();
      const result = await operation(state);
      await this.#save();
      return result;
    } finally {
      await lock?.close().catch(() => undefined);
      if (lock) await rm(this.#lockPath, { force: true });
      release();
    }
  }

  async issuePairing(): Promise<{ id: string; credential: string; expiresAt: string }> {
    return this.#mutate((state) => {
      const credential = randomBytes(32).toString("base64url");
      const grant: PairingGrant = {
        id: randomUUID(),
        digest: digest(credential),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
        usedAt: null,
      };
      state.pairingGrants.push(grant);
      return { id: grant.id, credential, expiresAt: grant.expiresAt };
    });
  }

  async pair(input: {
    credential: unknown;
    label: unknown;
    publicKey: unknown;
  }): Promise<PairingResult> {
    if (
      typeof input.credential !== "string" ||
      typeof input.label !== "string" ||
      !input.label.trim() ||
      !isP256PublicKey(input.publicKey)
    ) {
      throw new RemoteAuthError("A complete device pairing request is required.", 400);
    }
    return this.#mutate((state) => {
      const presented = digest(input.credential as string);
      const grant = state.pairingGrants.find((candidate) =>
        equalDigest(candidate.digest, presented),
      );
      if (!grant || grant.usedAt || Date.parse(grant.expiresAt) <= Date.now()) {
        throw new RemoteAuthError("The pairing credential is invalid, expired, or already used.");
      }
      grant.usedAt = new Date().toISOString();
      const token = randomBytes(32).toString("base64url");
      const session: RemoteSession = {
        id: randomUUID(),
        tokenDigest: digest(token),
        label: (input.label as string).trim().slice(0, 80),
        publicKey: input.publicKey as JsonWebKey,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        revokedAt: null,
      };
      state.sessions.push(session);
      return {
        hostId: state.hostId,
        sessionId: session.id,
        sessionToken: token,
        expiresAt: session.expiresAt,
      };
    });
  }

  async verify(request: IncomingMessage, body: Buffer): Promise<RemoteSession> {
    const authorization = request.headers.authorization;
    const timestamp = request.headers["x-aldunis-timestamp"];
    const nonce = request.headers["x-aldunis-nonce"];
    const signature = request.headers["x-aldunis-signature"];
    const signedOrigin = request.headers["x-aldunis-origin"];
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("DPoP ") ||
      typeof timestamp !== "string" ||
      typeof nonce !== "string" ||
      typeof signature !== "string" ||
      typeof signedOrigin !== "string"
    ) {
      throw new RemoteAuthError("Remote device proof is required.");
    }
    const [sessionId, token] = authorization.slice(5).split(".", 2);
    const state = await this.#load();
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (
      !session ||
      session.revokedAt ||
      Date.parse(session.expiresAt) <= Date.now() ||
      !equalDigest(session.tokenDigest, digest(token ?? ""))
    ) {
      throw new RemoteAuthError("The remote session is invalid, expired, or revoked.");
    }
    const proofTime = Number(timestamp);
    if (!Number.isFinite(proofTime) || Math.abs(Date.now() - proofTime) > PROOF_CLOCK_SKEW_MS) {
      throw new RemoteAuthError("The remote device proof is stale.");
    }
    const replayKey = `${session.id}:${nonce}`;
    assertRemoteProofNotReplayed(this.#replay, replayKey);
    assertRemoteProofReplayCapacity(this.#replay);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    let origin: URL;
    try {
      origin = new URL(signedOrigin);
    } catch {
      throw new RemoteAuthError("The remote device proof origin is invalid.");
    }
    const requestHost = request.headers.host ?? "";
    const originHostname = origin.hostname.replace(/^\[(.*)\]$/, "$1");
    let requestHostname = "";
    try {
      requestHostname = new URL(`http://${requestHost}`).hostname.replace(/^\[(.*)\]$/, "$1");
    } catch {
      requestHostname = "";
    }
    const loopbackHttp =
      this.#allowLoopbackHttp &&
      origin.protocol === "http:" &&
      (originHostname === "127.0.0.1" ||
        originHostname === "::1" ||
        originHostname === "localhost") &&
      (requestHostname === "127.0.0.1" ||
        requestHostname === "::1" ||
        requestHostname === "localhost");
    if (
      (!loopbackHttp && origin.protocol !== "https:") ||
      origin.host !== requestHost ||
      (typeof request.headers.origin === "string" && request.headers.origin !== signedOrigin)
    ) {
      throw new RemoteAuthError("The remote device proof targets another origin.");
    }
    const payload = [
      request.method ?? "POST",
      signedOrigin,
      path,
      timestamp,
      nonce,
      createHash("sha256").update(body).digest("base64url"),
    ].join("\n");
    let valid = false;
    try {
      valid = verify(
        "sha256",
        Buffer.from(payload),
        {
          key: createPublicKey({ key: session.publicKey, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw new RemoteAuthError("The remote device proof is invalid.");
    retainRemoteProofReplay(this.#replay, replayKey, Date.now() + REPLAY_TTL_MS);
    return session;
  }

  async listSessions(): Promise<
    Array<Pick<RemoteSession, "id" | "label" | "createdAt" | "expiresAt" | "revokedAt">>
  > {
    return (await this.#load()).sessions.map(({ id, label, createdAt, expiresAt, revokedAt }) => ({
      id,
      label,
      createdAt,
      expiresAt,
      revokedAt,
    }));
  }

  async revoke(sessionId: string): Promise<boolean> {
    return this.#mutate((state) => {
      const session = state.sessions.find((candidate) => candidate.id === sessionId);
      if (!session || session.revokedAt) return false;
      session.revokedAt = new Date().toISOString();
      return true;
    });
  }

  async descriptor(): Promise<{ hostId: string; protocolVersion: 1 }> {
    return { hostId: (await this.#load()).hostId, protocolVersion: 1 };
  }
}
