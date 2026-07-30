import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import { ClaudeProfileStore, type ProfileProbeKind } from "./profiles.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { LocalStateStore } from "./state.ts";

async function listen(remote: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profile-routes-"));
  const state = new LocalStateStore(directory);
  const profiles = new ClaudeProfileStore(directory);
  const remoteAuth = remote
    ? {
        verify: async () => ({}),
      } as unknown as RemoteAuth
    : undefined;
  const server = createLocalHost(directory, state, profiles, remoteAuth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    directory,
    profiles,
    server,
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
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("loopback clients can save, refresh, and delete provider profiles", async () => {
  const fixture = await listen(false);
  try {
    const savedResponse = await post(fixture.url, "/api/provider/profiles/save", {
      name: "Route test",
      provider: "codex-cli",
      binaryPath: process.execPath,
      environment: [],
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as { id: string };

    const kinds: ProfileProbeKind[] = ["availability", "version", "authentication", "models"];
    for (const kind of kinds) {
      const refreshed = await post(fixture.url, "/api/provider/profiles/refresh", {
        id: saved.id,
        kind,
      });
      assert.equal(refreshed.status, 200, `loopback ${kind} refresh should remain available`);
    }

    const deleted = await post(fixture.url, "/api/provider/profiles/delete", { id: saved.id });
    assert.equal(deleted.status, 200);
    assert.equal((await fixture.profiles.list()).some((profile) => profile.id === saved.id), false);
  } finally {
    await close(fixture.server);
  }
});

test("remote clients cannot save, delete, or refresh provider profiles", async () => {
  const fixture = await listen(true);
  const sentinel = join(fixture.directory, "profile-probe-ran");
  const executable = join(fixture.directory, "profile-probe");
  await writeFile(executable, `#!/bin/sh\nprintf ran > "${sentinel}"\n`);
  await chmod(executable, 0o700);
  const saved = await fixture.profiles.save({
    name: "Protected profile",
    provider: "codex-cli",
    binaryPath: executable,
    environment: [{ name: "REMOTE_PROFILE_SENTINEL", sensitive: false, value: "original" }],
  });

  try {
    const save = await post(fixture.url, "/api/provider/profiles/save", {
      id: saved.id,
      name: "Remote overwrite",
      provider: "codex-cli",
      binaryPath: process.execPath,
      environment: [{ name: "REMOTE_PROFILE_SENTINEL", sensitive: false, value: "changed" }],
    });
    assert.equal(save.status, 403);

    const kinds: ProfileProbeKind[] = ["availability", "version", "authentication", "models"];
    for (const kind of kinds) {
      const refreshed = await post(fixture.url, "/api/provider/profiles/refresh", {
        id: saved.id,
        kind,
      });
      assert.equal(refreshed.status, 403, `remote ${kind} refresh should be denied`);
    }

    const deleted = await post(fixture.url, "/api/provider/profiles/delete", { id: saved.id });
    assert.equal(deleted.status, 403);

    const retained = (await fixture.profiles.list()).find((profile) => profile.id === saved.id);
    assert.equal(retained?.name, "Protected profile");
    assert.equal(retained?.binaryPath, executable);
    assert.deepEqual(retained?.environment, [{
      name: "REMOTE_PROFILE_SENTINEL",
      sensitive: false,
      value: "original",
    }]);
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  } finally {
    await close(fixture.server);
  }
});
