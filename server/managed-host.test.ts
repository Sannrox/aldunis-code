import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import {
  loadManagedHostConfiguration,
  MAX_MANAGED_ASSERTION_PUBLIC_KEY_BYTES,
  ManagedHost,
  readManagedPublicKeyFile,
  type ManagedPublicKeyFileOperations,
  type ManagedHostConfiguration,
} from "./managed-host.ts";
import { LocalStateStore } from "./state.ts";

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function bodyDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("base64url");
}

function assertion(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  overrides: Record<string, unknown> = {},
  binding: { method?: string; path?: string; body?: Buffer } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const method = binding.method ?? "POST";
  const path = binding.path ?? "/api/host/capabilities";
  const body = binding.body ?? Buffer.from("{}", "utf8");
  const header = base64url({ alg: "EdDSA", typ: "JWT", kid: "managed-test" });
  const claims = {
    iss: "https://aldunis.test",
    aud: "aldunis-code-managed",
    sub: "service:gateway",
    tenant_id: "tenant-test",
    instance_id: "code-instance-test",
    scope: ["code:workbench"],
    code_mode: "managed",
    managed_profile: "aldunis-code-managed",
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    method,
    path,
    body_sha256: bodyDigest(body),
    ...overrides,
  };
  const payload = `${header}.${base64url(claims)}`;
  return `${payload}.${sign(null, Buffer.from(payload, "ascii"), privateKey).toString("base64url")}`;
}

function request(
  path: string,
  method = "POST",
  assertionValue?: string,
): import("node:http").IncomingMessage {
  return {
    method,
    url: path,
    headers: assertionValue ? { "x-aldunis-code-assertion": assertionValue } : {},
  } as import("node:http").IncomingMessage;
}

function configuration(
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
  root: string,
): ManagedHostConfiguration {
  return {
    issuer: "https://aldunis.test",
    audience: "aldunis-code-managed",
    tenantId: "tenant-test",
    instanceId: "code-instance-test",
    publicKey,
    logoutUrl: "https://aldunis.test/logout",
    repositories: [
      {
        id: "code",
        name: "Aldunis Code",
        root,
        device: statSync(root).dev,
        inode: statSync(root).ino,
      },
    ],
    shikigami: {
      executable: process.execPath,
      model: "operator-approved-model",
      governanceEndpoint: "https://chisei.internal",
      principal: "service:aldunis-code-managed",
      namespace: "tenant-test/code",
      tokenEnv: "SEKAI_TOKEN",
      token: "test-token",
      path: "/usr/bin:/bin",
    },
  };
}

async function withReplayDirectory<T>(run: (replayDirectory: string) => Promise<T>): Promise<T> {
  const replayDirectory = await mkdtemp(join(tmpdir(), "aldunis-managed-replay-"));
  try {
    return await run(replayDirectory);
  } finally {
    await rm(replayDirectory, { recursive: true, force: true });
  }
}

function managedEnvironment(root: string, publicKeyPem: string): NodeJS.ProcessEnv {
  return {
    ALDUNIS_MANAGED_ASSERTION_ISSUER: "https://aldunis.test",
    ALDUNIS_MANAGED_ASSERTION_AUDIENCE: "aldunis-code-managed",
    ALDUNIS_MANAGED_TENANT_ID: "tenant-test",
    ALDUNIS_MANAGED_INSTANCE_ID: "code-instance-test",
    ALDUNIS_MANAGED_ASSERTION_PUBLIC_KEY_PEM: publicKeyPem,
    ALDUNIS_MANAGED_REPOSITORIES_JSON: JSON.stringify([{ id: "code", name: "Aldunis Code", root }]),
    ALDUNIS_MANAGED_SHIKIGAMI_EXECUTABLE: process.execPath,
    ALDUNIS_MANAGED_SHIKIGAMI_MODEL: "operator-approved-model",
    ALDUNIS_MANAGED_SHIKIGAMI_GOVERNANCE_ENDPOINT: "https://chisei.internal",
    ALDUNIS_MANAGED_SHIKIGAMI_PRINCIPAL: "service:aldunis-code-managed",
    ALDUNIS_MANAGED_SHIKIGAMI_NAMESPACE: "tenant-test/code",
    SEKAI_TOKEN: "test-token",
  };
}

test("managed assertions fail closed for missing, altered, wrong-audience, and replayed context", async () => {
  await withReplayDirectory(async (replayDirectory) => {
    const keys = generateKeyPairSync("ed25519");
    const root = await realpath(process.cwd());
    const managed = new ManagedHost(configuration(keys.publicKey, root), { replayDirectory });
    const body = Buffer.from("{}", "utf8");
    const valid = assertion(keys.privateKey);

    await assert.rejects(() => managed.verify(request("/api/host/capabilities"), body), /required/);
    await managed.verify(request("/api/host/capabilities", "POST", valid), body);
    await assert.rejects(
      () => managed.verify(request("/api/host/capabilities", "POST", valid), body),
      /already used/,
    );
    await assert.rejects(
      () =>
        managed.verify(
          request(
            "/api/host/capabilities",
            "POST",
            assertion(keys.privateKey, { aud: "wrong-audience" }),
          ),
          body,
        ),
      /issuer or audience/,
    );
    const altered = assertion(keys.privateKey, { tenant_id: "tenant-tampered" });
    await assert.rejects(
      () => managed.verify(request("/api/host/capabilities", "POST", altered), body),
      /tenant/,
    );
    const wrongKey = generateKeyPairSync("ed25519");
    await assert.rejects(
      () =>
        managed.verify(
          request("/api/host/capabilities", "POST", assertion(wrongKey.privateKey)),
          body,
        ),
      /signature/,
    );
  });
});

test("managed assertion JTI replay fails closed after verifier restart against the same store", async () => {
  await withReplayDirectory(async (replayDirectory) => {
    const keys = generateKeyPairSync("ed25519");
    const root = await realpath(process.cwd());
    const body = Buffer.from("{}", "utf8");
    const token = assertion(keys.privateKey);
    const first = new ManagedHost(configuration(keys.publicKey, root), { replayDirectory });
    await first.verify(request("/api/host/capabilities", "POST", token), body);

    const restarted = new ManagedHost(configuration(keys.publicKey, root), { replayDirectory });
    await assert.rejects(
      () => restarted.verify(request("/api/host/capabilities", "POST", token), body),
      /already used/,
    );
  });
});

test("managed assertions reject missing request bindings on protected routes", async () => {
  await withReplayDirectory(async (replayDirectory) => {
    const keys = generateKeyPairSync("ed25519");
    const root = await realpath(process.cwd());
    const managed = new ManagedHost(configuration(keys.publicKey, root), { replayDirectory });
    const body = Buffer.from("{}", "utf8");

    await assert.rejects(
      () =>
        managed.verify(
          request(
            "/api/host/capabilities",
            "POST",
            assertion(keys.privateKey, {
              method: undefined,
              path: undefined,
              body_sha256: undefined,
            }),
          ),
          body,
        ),
      /missing method/,
    );
    await assert.rejects(
      () =>
        managed.verify(
          request(
            "/api/state/history",
            "POST",
            assertion(keys.privateKey, { path: undefined }, { path: "/api/state/history" }),
          ),
          body,
        ),
      /missing path/,
    );
    await assert.rejects(
      () =>
        managed.verify(
          request(
            "/api/host/capabilities",
            "POST",
            assertion(keys.privateKey, { body_sha256: undefined }),
          ),
          body,
        ),
      /missing body_sha256/,
    );
    await assert.rejects(
      () =>
        managed.verify(
          request(
            "/api/approvals/respond",
            "POST",
            assertion(
              keys.privateKey,
              {},
              { path: "/api/host/capabilities", body: Buffer.from('{"ok":true}', "utf8") },
            ),
          ),
          Buffer.from('{"ok":true}', "utf8"),
        ),
      /path binding/,
    );
  });
});

test("managed verification returns a bounded account projection from signed claims", async () => {
  await withReplayDirectory(async (replayDirectory) => {
    const keys = generateKeyPairSync("ed25519");
    const root = await realpath(process.cwd());
    const managed = new ManagedHost(configuration(keys.publicKey, root), { replayDirectory });
    const sessionExp = Math.floor(Date.now() / 1000) + 3_600;
    const identity = await managed.verify(
      request(
        "/api/host/capabilities",
        "POST",
        assertion(keys.privateKey, {
          name: "Ada Lovelace",
          roles: ["developer", "reviewer"],
          session_exp: sessionExp,
        }),
      ),
      Buffer.from("{}", "utf8"),
    );

    assert.equal(identity.displayName, "Ada Lovelace");
    assert.equal(identity.tenantId, "tenant-test");
    assert.deepEqual(identity.roles, ["developer", "reviewer"]);
    assert.deepEqual(identity.scopes, ["code:workbench"]);
    assert.equal(identity.sessionExpiresAt, new Date(sessionExp * 1000).toISOString());
    assert.equal(identity.logoutUrl, "https://aldunis.test/logout");

    const account = (
      managed.capabilities(identity) as {
        account?: Record<string, unknown> | null;
      }
    ).account;
    assert.equal(account?.displayName, "Ada Lovelace");
    assert.equal("subject" in (account ?? {}), false);
  });
});

test("managed startup configuration is required and Shikigami runtime excludes ambient credentials", async () => {
  await assert.rejects(
    () => loadManagedHostConfiguration({}),
    /ALDUNIS_MANAGED_ASSERTION_ISSUER is required/,
  );

  await withReplayDirectory(async (replayDirectory) => {
    const keys = generateKeyPairSync("ed25519");
    const managed = new ManagedHost(configuration(keys.publicKey, await realpath(process.cwd())), {
      replayDirectory,
    });
    const capabilities = managed.capabilities() as {
      repositories: Array<Record<string, unknown>>;
      provider: Record<string, unknown>;
    };
    assert.deepEqual(capabilities.repositories, [{ id: "code", name: "Aldunis Code" }]);
    assert.equal("root" in capabilities.repositories[0]!, false);
    assert.equal(capabilities.provider.modelAdapter, "plane");
    assert.equal(capabilities.provider.governanceAdapter, "sekai-chisei");

    const root = await realpath(process.cwd());
    const validConfiguration = configuration(keys.publicKey, root);
    const replacedIdentity = new ManagedHost(
      {
        ...validConfiguration,
        repositories: [
          {
            ...validConfiguration.repositories[0]!,
            device: 0,
            inode: 0,
          },
        ],
      },
      { replayDirectory },
    );
    await assert.rejects(
      () => replacedIdentity.selectWorktree(root, root),
      /filesystem identity changed/,
    );
  });
});

test("managed assertion public-key loading bounds inline and file-backed input", async () => {
  const root = await realpath(process.cwd());
  const pem = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem",
  });
  const directory = await mkdtemp(join(tmpdir(), "aldunis-managed-key-"));
  const path = join(directory, "assertion.pem");
  await writeFile(path, pem);

  const fileEnvironment = managedEnvironment(root, "");
  delete fileEnvironment.ALDUNIS_MANAGED_ASSERTION_PUBLIC_KEY_PEM;
  fileEnvironment.ALDUNIS_MANAGED_ASSERTION_PUBLIC_KEY_FILE = path;
  const loaded = await loadManagedHostConfiguration(fileEnvironment);
  assert.equal(loaded.publicKey.asymmetricKeyType, "ed25519");

  const oversized = managedEnvironment(
    root,
    "a".repeat(MAX_MANAGED_ASSERTION_PUBLIC_KEY_BYTES + 1),
  );
  await assert.rejects(
    () => loadManagedHostConfiguration(oversized),
    (error: Error) =>
      error.message === "Managed assertion public key is invalid or unreadable." &&
      !error.message.includes("a".repeat(32)),
  );
  const whitespaceOversized = managedEnvironment(
    root,
    `${" ".repeat(MAX_MANAGED_ASSERTION_PUBLIC_KEY_BYTES)}${pem}`,
  );
  await assert.rejects(
    () => loadManagedHostConfiguration(whitespaceOversized),
    /Managed assertion public key is invalid or unreadable/,
  );
});

test("managed assertion public-key files reject oversize before content allocation", async () => {
  let read = false;
  let closed = false;
  const identity = {
    size: MAX_MANAGED_ASSERTION_PUBLIC_KEY_BYTES + 1,
    dev: 1,
    ino: 2,
    mode: 0o100600,
    mtimeMs: 3,
    ctimeMs: 4,
  };
  const operations: ManagedPublicKeyFileOperations = {
    stat: async () => identity,
    open: async () => ({
      stat: async () => identity,
      read: async () => {
        read = true;
        return { bytesRead: 0 };
      },
      close: async () => {
        closed = true;
      },
    }),
  };

  await assert.rejects(
    () => readManagedPublicKeyFile("fixture.pem", operations),
    /exceeds the supported size/,
  );
  assert.equal(read, false);
  assert.equal(closed, true);
});

test("managed assertion public-key files close and reject concurrent changes", async () => {
  const mutations = {
    shrink: async (path: string) => truncate(path, 1),
    growth: async (path: string) => writeFile(path, "more", { flag: "a" }),
    mutation: async (path: string) => writeFile(path, "changed!"),
    replacement: async (path: string) => {
      const next = `${path}.next`;
      await writeFile(next, "replace");
      await rename(next, path);
    },
    disappearance: async (path: string) => unlink(path),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const directory = await mkdtemp(join(tmpdir(), `aldunis-managed-key-${name}-`));
    const path = join(directory, "assertion.pem");
    await writeFile(path, "original");
    let closed = false;
    let mutated = false;
    const operations: ManagedPublicKeyFileOperations = {
      stat,
      open: async (candidate) => {
        const handle = await open(candidate, "r");
        return {
          close: async () => {
            closed = true;
            await handle.close();
          },
          read: async (buffer, offset, length, position) => {
            const result = await handle.read(buffer, offset, length, position);
            if (!mutated) {
              mutated = true;
              await mutate(candidate);
            }
            return { bytesRead: result.bytesRead };
          },
          stat: () => handle.stat(),
        };
      },
    };

    await assert.rejects(() => readManagedPublicKeyFile(path, operations));
    assert.equal(closed, true, `${name} must close the public-key handle`);
  }
});

test("managed assertion public-key files reject short reads and close failures", async () => {
  const identity = { size: 1, dev: 1, ino: 2, mode: 0o100600, mtimeMs: 3, ctimeMs: 4 };
  let shortClosed = false;
  await assert.rejects(
    () =>
      readManagedPublicKeyFile("short.pem", {
        stat: async () => identity,
        open: async () => ({
          stat: async () => identity,
          read: async () => ({ bytesRead: 0 }),
          close: async () => {
            shortClosed = true;
          },
        }),
      }),
    /changed while being read/,
  );
  assert.equal(shortClosed, true);

  await assert.rejects(
    () =>
      readManagedPublicKeyFile("close.pem", {
        stat: async () => identity,
        open: async () => ({
          stat: async () => identity,
          read: async (buffer, offset, length, position) => {
            if (position >= identity.size) return { bytesRead: 0 };
            buffer.fill(0, offset, offset + length);
            return { bytesRead: length };
          },
          close: async () => {
            throw new Error("sensitive close detail");
          },
        }),
      }),
    /could not be closed/,
  );
});

test("managed worktree selection uses discovered canonical membership", async () => {
  await withReplayDirectory(async (replayDirectory) => {
    const keys = generateKeyPairSync("ed25519");
    const root = await realpath(process.cwd());
    const managed = new ManagedHost(configuration(keys.publicKey, root), { replayDirectory });
    const outside = await mkdtemp(join(root, ".aldunis-managed-unregistered-worktree-"));

    try {
      assert.deepEqual(await managed.selectWorktree(root, root), {
        root,
        worktree: root,
        repositoryId: "code",
      });
      await assert.rejects(
        () => managed.selectWorktree(root, outside),
        /Select a discovered worktree from the managed repository/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("managed HTTP routes require gateway assertions and reject local control overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-managed-host-"));
  const state = new LocalStateStore(directory);
  const keys = generateKeyPairSync("ed25519");
  const root = await realpath(process.cwd());
  const managed = new ManagedHost(configuration(keys.publicKey, root), {
    replayDirectory: directory,
  });
  const server = createLocalHost({ dist: directory, state, managedHost: managed });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const post = async (route: string, body: Record<string, unknown>) => {
    const serialized = JSON.stringify(body);
    const token = assertion(
      keys.privateKey,
      {},
      { method: "POST", path: route, body: Buffer.from(serialized, "utf8") },
    );
    return fetch(`${url}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aldunis-code-assertion": token,
      },
      body: serialized,
    });
  };
  try {
    const descriptor = await fetch(`${url}/api/remote/descriptor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(descriptor.status, 200);
    assert.deepEqual(await descriptor.json(), { remoteEnabled: false, hostedMode: true });

    const missing = await fetch(`${url}/api/host/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 401);

    const unbound = await fetch(`${url}/api/host/capabilities`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aldunis-code-assertion": assertion(keys.privateKey, {
          method: undefined,
          path: undefined,
          body_sha256: undefined,
        }),
      },
      body: "{}",
    });
    assert.equal(unbound.status, 401);
    assert.match((await unbound.json()).error as string, /missing method/);

    const capabilities = await post("/api/host/capabilities", {});
    assert.equal(capabilities.status, 200);
    const capabilityBody = (await capabilities.json()) as {
      mode: string;
      managed: boolean;
      account?: {
        displayName: string;
        tenantId: string;
        logoutUrl: string | null;
      } | null;
    };
    assert.equal(capabilityBody.mode, "managed");
    assert.equal(capabilityBody.managed, true);
    assert.equal(capabilityBody.account?.displayName, "Enterprise user");
    assert.equal(capabilityBody.account?.tenantId, "tenant-test");
    assert.equal(capabilityBody.account?.logoutUrl, "https://aldunis.test/logout");

    const arbitraryPath = await post("/api/repositories/open", { path: root });
    assert.equal(arbitraryPath.status, 403);
    const opened = await post("/api/repositories/open", { repositoryId: "code" });
    assert.equal(opened.status, 200);
    assert.equal(
      ((await opened.json()) as { managedRepositoryId?: string }).managedRepositoryId,
      "code",
    );

    const binding = await post("/api/integrations/chisei/bind", {});
    assert.equal(binding.status, 403);
    const delivery = await post("/api/delivery/plans", {});
    assert.equal(delivery.status, 403);
    const releaseDelivery = await post("/api/release-delivery/inspect", {});
    assert.equal(releaseDelivery.status, 403);
    const skills = await post("/api/provider/skills", {
      provider: "codex-cli",
      root,
      worktree: root,
    });
    assert.equal(skills.status, 403);
    const automations = await post("/api/automations/list", {});
    assert.equal(automations.status, 200);
    assert.deepEqual(await automations.json(), { automations: [] });
    const retention = await post("/api/state/retention", { olderThan: new Date().toISOString() });
    assert.equal(retention.status, 403);
    const fork = await post("/api/forks/create", {
      sourceThreadId: randomUUID(),
      provider: "claude-code",
      profileId: "default:claude-code",
      model: "caller-selected-model",
      expectedDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    assert.equal(fork.status, 403);

    const profiles = await post("/api/provider/profiles/save", { name: "attempted override" });
    assert.equal(profiles.status, 403);
    const before = await state.load();
    const override = await post("/api/provider/runs", {
      root,
      worktree: root,
      prompt: "should be rejected before mutation",
      conversationId: randomUUID(),
      mode: "ask",
      provider: "claude-code",
      model: "caller-selected-model",
    });
    assert.equal(override.status, 403);
    const after = await state.load();
    assert.equal(after.turns.length, before.turns.length);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
