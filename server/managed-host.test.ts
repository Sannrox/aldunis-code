import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import {
  loadManagedHostConfiguration,
  ManagedHost,
  type ManagedHostConfiguration,
} from "./managed-host.ts";
import { LocalStateStore } from "./state.ts";

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function assertion(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  overrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
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

test("managed assertions fail closed for missing, altered, wrong-audience, and replayed context", async () => {
  const keys = generateKeyPairSync("ed25519");
  const root = await realpath(process.cwd());
  const managed = new ManagedHost(configuration(keys.publicKey, root));
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

test("managed verification returns a bounded account projection from signed claims", async () => {
  const keys = generateKeyPairSync("ed25519");
  const root = await realpath(process.cwd());
  const managed = new ManagedHost(configuration(keys.publicKey, root));
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

test("managed startup configuration is required and Shikigami runtime excludes ambient credentials", async () => {
  await assert.rejects(
    () => loadManagedHostConfiguration({}),
    /ALDUNIS_MANAGED_ASSERTION_ISSUER is required/,
  );

  const keys = generateKeyPairSync("ed25519");
  const managed = new ManagedHost(configuration(keys.publicKey, await realpath(process.cwd())));
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
  const replacedIdentity = new ManagedHost({
    ...validConfiguration,
    repositories: [
      {
        ...validConfiguration.repositories[0]!,
        device: 0,
        inode: 0,
      },
    ],
  });
  await assert.rejects(
    () => replacedIdentity.selectWorktree(root, root),
    /filesystem identity changed/,
  );
});

test("managed worktree selection uses discovered canonical membership", async () => {
  const keys = generateKeyPairSync("ed25519");
  const root = await realpath(process.cwd());
  const managed = new ManagedHost(configuration(keys.publicKey, root));
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

test("managed HTTP routes require gateway assertions and reject local control overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-managed-host-"));
  const state = new LocalStateStore(directory);
  const keys = generateKeyPairSync("ed25519");
  const root = await realpath(process.cwd());
  const managed = new ManagedHost(configuration(keys.publicKey, root));
  const server = createLocalHost({ dist: directory, state, managedHost: managed });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const post = async (
    route: string,
    body: Record<string, unknown>,
    token = assertion(keys.privateKey),
  ) =>
    fetch(`${url}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aldunis-code-assertion": token,
      },
      body: JSON.stringify(body),
    });
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
  }
});
