import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLocalHost } from "./host.ts";
import { ClaudeProfileStore, type ProfileProbeKind } from "./profiles.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { LocalStateStore } from "./state.ts";

const execFileAsync = promisify(execFile);

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

test("provider discovery reports readiness and models for each Shikigami profile", async () => {
  const fixture = await listen(false);
  const executable = join(fixture.directory, "shikigami-profile-probe");
  const config = join(fixture.directory, "custom-shikigami.toml");
  await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'shikigami 1.0.4'; fi\n");
  await chmod(executable, 0o700);
  await writeFile(config, [
    "[model]",
    'adapter = "http"',
    'model = "custom-model"',
    'api_key_env = "PROFILE_DISCOVERY_KEY"',
    'base_url = "https://example.invalid/v1"',
  ].join("\n"));
  await fixture.profiles.save({
    name: "Custom Shikigami",
    provider: "shikigami",
    binaryPath: executable,
    configPath: config,
    environment: [{ name: "PROFILE_DISCOVERY_KEY", sensitive: false, value: "test-token" }],
  });

  try {
    const response = await post(fixture.url, "/api/providers/discover", {});
    assert.equal(response.status, 200);
    const body = await response.json() as {
      providers?: Array<{
        id: string;
        profileDiscoveries?: Array<{
          profileId: string;
          installed: boolean;
          authenticated?: boolean;
          models?: Array<{ id: string }>;
        }>;
      }>;
    };
    const shikigami = body.providers?.find((provider) => provider.id === "shikigami");
    const custom = shikigami?.profileDiscoveries?.find((profile) => profile.profileId !== "default:shikigami");
    assert.ok(custom);
    assert.equal(custom.installed, true);
    assert.equal(custom.authenticated, true);
    assert.equal(custom.models?.[0]?.id, "custom-model");
  } finally {
    await close(fixture.server);
  }
});

test("provider discovery resolves native Shikigami config from the selected worktree", async () => {
  const fixture = await listen(false);
  const repository = await mkdtemp(join(tmpdir(), "aldunis-profile-discovery-repo-"));
  const executable = join(fixture.directory, "shikigami-native-probe");
  await execFileAsync("git", ["-C", repository, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Aldunis Test"]);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'shikigami 1.0.4'; fi\n");
  await chmod(executable, 0o700);
  await writeFile(join(repository, "shikigami.toml"), [
    "[model]",
    'adapter = "http"',
    'model = "native-worktree-model"',
    'api_key_env = "WORKTREE_DISCOVERY_KEY"',
  ].join("\n"));
  await fixture.profiles.save({
    name: "Native worktree Shikigami",
    provider: "shikigami",
    binaryPath: executable,
    environment: [{ name: "WORKTREE_DISCOVERY_KEY", sensitive: false, value: "test-token" }],
  });

  try {
    const response = await post(fixture.url, "/api/providers/discover", {
      root: repository,
      worktree: repository,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      providers?: Array<{
        id: string;
        profileDiscoveries?: Array<{
          profileId: string;
          models?: Array<{ id: string }>;
        }>;
      }>;
    };
    const shikigami = body.providers?.find((provider) => provider.id === "shikigami");
    const native = shikigami?.profileDiscoveries?.find((profile) => profile.profileId !== "default:shikigami");
    assert.equal(native?.models?.[0]?.id, "native-worktree-model");
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
