import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_ACTIVE_REMOTE_SESSIONS,
  MAX_LIVE_PAIRING_GRANTS,
  MAX_RETAINED_TERMINAL_REMOTE_SESSIONS,
  MAX_REMOTE_AUTH_STATE_BYTES,
  MAX_REMOTE_PROOF_REPLAY_ENTRIES,
  RemoteAuth,
  RemoteAuthError,
  assertRemoteProofNotReplayed,
  assertRemoteProofReplayCapacity,
  readRemoteAuthStateFile,
  retainRemoteProofReplay,
  type RemoteAuthStateFileOperations,
} from "./remote-auth.ts";

test("remote pairing authority retention exposes finite production bounds", () => {
  assert.equal(MAX_LIVE_PAIRING_GRANTS, 32);
  assert.equal(MAX_ACTIVE_REMOTE_SESSIONS, 64);
  assert.equal(MAX_RETAINED_TERMINAL_REMOTE_SESSIONS, 32);
  assert.equal(MAX_REMOTE_AUTH_STATE_BYTES, 1024 * 1024);
});

function stateFileOperations(options: {
  bytes: Buffer;
  initialSize?: number;
  finalHandle?: Partial<{
    size: number;
    dev: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
  }>;
  finalPath?: Partial<{
    size: number;
    dev: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
  }>;
  pathStatError?: Error;
  readError?: Error;
}): RemoteAuthStateFileOperations {
  const initial = {
    size: options.initialSize ?? options.bytes.length,
    dev: 1,
    ino: 2,
    mtimeMs: 3,
    ctimeMs: 4,
  };
  const finalHandle = { ...initial, ...options.finalHandle };
  const finalPath = { ...finalHandle, ...options.finalPath };
  let handleStats = 0;
  return {
    async open() {
      return {
        async stat() {
          handleStats += 1;
          return handleStats === 1 ? initial : finalHandle;
        },
        async read(buffer, offset, length, position) {
          if (options.readError) throw options.readError;
          const bytesRead = Math.min(length, Math.max(0, options.bytes.length - position));
          if (bytesRead > 0) options.bytes.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead };
        },
        async close() {},
      };
    },
    async stat() {
      if (options.pathStatError) throw options.pathStatError;
      return finalPath;
    },
  };
}

test("remote auth state rejects oversize from metadata before reading content", async () => {
  let read = false;
  const operations = stateFileOperations({ bytes: Buffer.alloc(0), initialSize: 9 });
  const originalOpen = operations.open;
  operations.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read;
    handle.read = async (...readArgs) => {
      read = true;
      return originalRead(...readArgs);
    };
    return handle;
  };

  await assert.rejects(
    () => readRemoteAuthStateFile("ignored", 8, operations),
    /exceeds the supported size/,
  );
  assert.equal(read, false);
});

test("remote auth state rejects shrink, growth, mutation, replacement, and disappearance", async () => {
  const changed = /changed while it was being read/;
  await assert.rejects(
    () =>
      readRemoteAuthStateFile(
        "ignored",
        8,
        stateFileOperations({ bytes: Buffer.from("abc"), initialSize: 4 }),
      ),
    changed,
  );
  await assert.rejects(
    () =>
      readRemoteAuthStateFile(
        "ignored",
        8,
        stateFileOperations({ bytes: Buffer.from("abcd"), initialSize: 3 }),
      ),
    changed,
  );
  await assert.rejects(
    () =>
      readRemoteAuthStateFile(
        "ignored",
        8,
        stateFileOperations({ bytes: Buffer.from("abc"), finalHandle: { mtimeMs: 5 } }),
      ),
    changed,
  );
  await assert.rejects(
    () =>
      readRemoteAuthStateFile(
        "ignored",
        8,
        stateFileOperations({ bytes: Buffer.from("abc"), finalPath: { ino: 9 } }),
      ),
    changed,
  );
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  await assert.rejects(
    () =>
      readRemoteAuthStateFile(
        "ignored",
        8,
        stateFileOperations({ bytes: Buffer.from("abc"), readError: missing }),
      ),
    changed,
  );
  await assert.rejects(
    () =>
      readRemoteAuthStateFile(
        "ignored",
        8,
        stateFileOperations({ bytes: Buffer.from("abc"), pathStatError: missing }),
      ),
    changed,
  );
});

test("remote auth treats only initial absence as an empty first-run state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-auth-absence-"));
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const auth = new RemoteAuth(directory, {
    stateFileOperations: {
      async open() {
        throw missing;
      },
      async stat() {
        throw new Error("unexpected path stat");
      },
    },
  });

  await auth.issuePairing();
  const stored = JSON.parse(await readFile(join(directory, "remote-auth.v1.json"), "utf8")) as {
    pairingGrants: unknown[];
  };
  assert.equal(stored.pairingGrants.length, 1);
});

test("remote auth rejects oversize writes without replacing prior state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-auth-write-bound-"));
  await new RemoteAuth(directory).issuePairing();
  const path = join(directory, "remote-auth.v1.json");
  const before = await readFile(path);
  const auth = new RemoteAuth(directory, { maxStateBytes: before.length });

  await assert.rejects(() => auth.issuePairing(), /exceeds the supported size/);
  assert.deepEqual(await readFile(path), before);
});

test("remote auth rejects an oversized persisted file through the public API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-auth-read-bound-"));
  await writeFile(
    join(directory, "remote-auth.v1.json"),
    Buffer.alloc(MAX_REMOTE_AUTH_STATE_BYTES + 1),
  );

  await assert.rejects(
    () => new RemoteAuth(directory).listSessions(),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 500,
  );
});

test("pairing grant admission prunes expiry and rejects live overflow", async () => {
  let now = Date.parse("2026-08-12T09:00:00.000Z");
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-auth-retention-"));
  const auth = new RemoteAuth(directory, { now: () => now, maxPairingGrants: 2 });

  await auth.issuePairing();
  await auth.issuePairing();
  await assert.rejects(
    () => auth.issuePairing(),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 429,
  );

  now += 10 * 60_000 + 1;
  await auth.issuePairing();
  const stored = JSON.parse(await readFile(join(directory, "remote-auth.v1.json"), "utf8")) as {
    pairingGrants: unknown[];
  };
  assert.equal(stored.pairingGrants.length, 1);
});

test("remote session retention bounds active authority and terminal history", async () => {
  let now = Date.parse("2026-08-12T09:00:00.000Z");
  const auth = new RemoteAuth(await mkdtemp(join(tmpdir(), "aldunis-remote-auth-retention-")), {
    now: () => now,
    maxActiveSessions: 2,
    maxTerminalSessions: 1,
  });
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ format: "jwk" });
  const pairDevice = async (label: string) => {
    const pairing = await auth.issuePairing();
    return auth.pair({ credential: pairing.credential, label, publicKey });
  };

  const first = await pairDevice("First");
  const second = await pairDevice("Second");
  const overflow = await auth.issuePairing();
  await assert.rejects(
    () => auth.pair({ credential: overflow.credential, label: "Overflow", publicKey }),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 429,
  );

  assert.equal(await auth.revoke(second.sessionId), true);
  const third = await auth.pair({ credential: overflow.credential, label: "Third", publicKey });
  now += 1_000;
  assert.equal(await auth.revoke(first.sessionId), true);
  const sessions = await auth.listSessions();
  assert.deepEqual(
    sessions.map((session) => session.id),
    [first.sessionId, third.sessionId],
  );
  assert.equal(sessions[0]?.revokedAt !== null, true);

  now += 30 * 24 * 60 * 60_000 + 1;
  assert.deepEqual(
    (await auth.listSessions()).map((session) => session.id),
    [third.sessionId],
  );
});

function proof(
  session: { sessionId: string; sessionToken: string },
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  body: Buffer,
  nonce = randomUUID(),
  timestamp = Date.now(),
  origin = "https://aldunis.test",
): IncomingMessage {
  const path = "/api/state/load";
  const payload = [
    "POST",
    origin,
    path,
    timestamp.toString(),
    nonce,
    createHash("sha256").update(body).digest("base64url"),
  ].join("\n");
  return {
    method: "POST",
    url: path,
    headers: {
      authorization: `DPoP ${session.sessionId}.${session.sessionToken}`,
      "x-aldunis-timestamp": timestamp.toString(),
      "x-aldunis-nonce": nonce,
      "x-aldunis-signature": sign("sha256", Buffer.from(payload), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
      "x-aldunis-origin": origin,
      origin,
      host: "aldunis.test",
    },
  } as IncomingMessage;
}

test("remote proof replay retention expires entries and fails closed at capacity", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const replay = new Map<string, number>([
    ["expired", now],
    ["live-1", now + 60_000],
  ]);

  retainRemoteProofReplay(replay, "live-2", now + 60_000, now, 2);
  assert.deepEqual([...replay.keys()], ["live-1", "live-2"]);
  assert.throws(
    () => assertRemoteProofReplayCapacity(replay, now, 2),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 503,
  );
  assert.equal(replay.size, 2);
  assert.throws(
    () => assertRemoteProofNotReplayed(replay, "live-1", now),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 401,
  );
  assert.equal(MAX_REMOTE_PROOF_REPLAY_ENTRIES, 10_000);
});

test("pairing is single-use and sessions require non-replayed device proof", async () => {
  const auth = new RemoteAuth(await mkdtemp(join(tmpdir(), "aldunis-remote-auth-")));
  const pairing = await auth.issuePairing();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ format: "jwk" });
  const session = await auth.pair({
    credential: pairing.credential,
    label: "Test iPad",
    publicKey,
  });
  await assert.rejects(
    () => auth.pair({ credential: pairing.credential, label: "Replay", publicKey }),
    /already used/,
  );
  const body = Buffer.from("{}");
  const request = proof(session, keys.privateKey, body);
  assert.equal((await auth.verify(request, body)).label, "Test iPad");
  request.headers["x-aldunis-signature"] = "invalid";
  await assert.rejects(() => auth.verify(request, body), /replayed/);
});

test("tampered, stale, and revoked device proofs fail closed", async () => {
  const auth = new RemoteAuth(await mkdtemp(join(tmpdir(), "aldunis-remote-auth-")));
  const pairing = await auth.issuePairing();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const session = await auth.pair({
    credential: pairing.credential,
    label: "Test browser",
    publicKey: keys.publicKey.export({ format: "jwk" }),
  });
  await assert.rejects(
    () =>
      auth.verify(
        proof(session, keys.privateKey, Buffer.from("{}")),
        Buffer.from('{"changed":true}'),
      ),
    /invalid/,
  );
  await assert.rejects(
    () =>
      auth.verify(
        proof(session, keys.privateKey, Buffer.from("{}"), randomUUID(), Date.now() - 120_000),
        Buffer.from("{}"),
      ),
    /stale/,
  );
  const wrongOrigin = proof(session, keys.privateKey, Buffer.from("{}"));
  wrongOrigin.headers.host = "attacker.example";
  await assert.rejects(() => auth.verify(wrongOrigin, Buffer.from("{}")), /another origin/);
  assert.equal(await auth.revoke(session.sessionId), true);
  await assert.rejects(
    () => auth.verify(proof(session, keys.privateKey, Buffer.from("{}")), Buffer.from("{}")),
    /revoked/,
  );
});

test("persisted remote state stores digests and public keys, never raw credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-auth-"));
  const auth = new RemoteAuth(directory);
  const pairing = await auth.issuePairing();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const session = await auth.pair({
    credential: pairing.credential,
    label: "Persistence test",
    publicKey: keys.publicKey.export({ format: "jwk" }),
  });
  const stored = await readFile(join(directory, "remote-auth.v1.json"), "utf8");
  assert.equal(stored.includes(pairing.credential), false);
  assert.equal(stored.includes(session.sessionToken), false);
  assert.equal(stored.includes('"d"'), false);
  assert.match(stored, /Persistence test/);
});

test("SSH remote authentication permits only the loopback HTTP origin", async () => {
  const auth = new RemoteAuth(await mkdtemp(join(tmpdir(), "aldunis-remote-auth-")), {
    allowLoopbackHttp: true,
  });
  const pairing = await auth.issuePairing();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const session = await auth.pair({
    credential: pairing.credential,
    label: "SSH desktop",
    publicKey: keys.publicKey.export({ format: "jwk" }),
  });
  const body = Buffer.from("{}");
  const request = proof(
    session,
    keys.privateKey,
    body,
    randomUUID(),
    Date.now(),
    "http://127.0.0.1:49152",
  );
  request.headers.host = "127.0.0.1:49152";
  assert.equal((await auth.verify(request, body)).label, "SSH desktop");

  const publicRequest = proof(
    session,
    keys.privateKey,
    body,
    randomUUID(),
    Date.now(),
    "http://192.168.1.10:49152",
  );
  publicRequest.headers.host = "192.168.1.10:49152";
  await assert.rejects(() => auth.verify(publicRequest, body), /another origin/);
});

test("a running host observes pairing and revocation changes from another process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-auth-"));
  const runningHost = new RemoteAuth(directory);
  const localCli = new RemoteAuth(directory);
  const pairing = await localCli.issuePairing();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const session = await runningHost.pair({
    credential: pairing.credential,
    label: "Cross-process test",
    publicKey: keys.publicKey.export({ format: "jwk" }),
  });
  const body = Buffer.from("{}");
  assert.equal(
    (await runningHost.verify(proof(session, keys.privateKey, body), body)).label,
    "Cross-process test",
  );
  assert.equal(await localCli.revoke(session.sessionId), true);
  await assert.rejects(
    () => runningHost.verify(proof(session, keys.privateKey, body), body),
    /revoked/,
  );
});

test("concurrent processes cannot redeem one pairing credential twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-auth-"));
  const issuer = new RemoteAuth(directory);
  const pairing = await issuer.issuePairing();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const input = {
    credential: pairing.credential,
    label: "Concurrent device",
    publicKey: keys.publicKey.export({ format: "jwk" }),
  };
  const results = await Promise.allSettled([
    new RemoteAuth(directory).pair(input),
    new RemoteAuth(directory).pair(input),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});
