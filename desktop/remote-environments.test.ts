import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SSH_REMOTE_PORT } from "../src/ports.ts";
import {
  buildSshForwardArguments,
  buildSshPairingArguments,
  buildSshServerArguments,
  DEFAULT_REMOTE_BACKEND_PORT,
  DEFAULT_REMOTE_COMMAND,
  normalizeRemoteEnvironmentInput,
  RemoteEnvironmentStore,
  assertSshRemoteDescriptor,
} from "./remote-environments.ts";

test("remote environment inputs keep endpoints origin-only and SSH launch arguments fixed", () => {
  const endpoint = normalizeRemoteEnvironmentInput({
    label: "Tailnet host",
    transport: "endpoint",
    endpoint: "https://code.example.test/",
    pairingUrl: "https://code.example.test/#pair=abcdefghijklmnopqrstuvwxyz0123456789_-",
  });
  assert.equal(endpoint.record.endpoint, "https://code.example.test");
  assert.equal(endpoint.record.remotePort, DEFAULT_REMOTE_BACKEND_PORT);
  assert.equal(DEFAULT_REMOTE_BACKEND_PORT, DEFAULT_SSH_REMOTE_PORT);
  assert.equal(DEFAULT_REMOTE_BACKEND_PORT, 4177);
  assert.equal(endpoint.record.remoteCommand, DEFAULT_REMOTE_COMMAND);
  assert.throws(
    () => normalizeRemoteEnvironmentInput({
      label: "unsafe",
      transport: "endpoint",
      endpoint: "http://192.168.1.20:4174",
    }),
    /HTTPS origins/,
  );
  assert.throws(
    () => normalizeRemoteEnvironmentInput({
      label: "unsafe",
      transport: "ssh",
      sshTarget: "prod; touch ~/.ssh/authorized_keys",
    }),
    /SSH targets/,
  );
  assert.deepEqual(
    buildSshForwardArguments("dev@example.test", 49152, DEFAULT_REMOTE_BACKEND_PORT),
    [
      "-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-L",
      "127.0.0.1:49152:127.0.0.1:4177", "dev@example.test",
    ],
  );
  assert.deepEqual(
    buildSshServerArguments("dev@example.test", "/opt/bin/aldunis-code", DEFAULT_REMOTE_BACKEND_PORT),
    [
      "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "dev@example.test",
      "/opt/bin/aldunis-code", "serve", "--remote", "ssh", "--host", "127.0.0.1",
      "--port", "4177",
    ],
  );
  assert.deepEqual(
    buildSshPairingArguments("dev@example.test", "/opt/bin/aldunis-code"),
    [
      "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
      "dev@example.test", "/opt/bin/aldunis-code", "auth", "pairing", "create",
    ],
  );
});

test("SSH connections require the authenticated remote descriptor", () => {
  assert.doesNotThrow(() => assertSshRemoteDescriptor({ remoteEnabled: true }));
  assert.throws(
    () => assertSshRemoteDescriptor({ remoteEnabled: false }),
    /did not enable authenticated remote access/,
  );
});

test("remote environment store persists metadata without pairing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-environments-"));
  const store = new RemoteEnvironmentStore(join(directory, "connections.v1.json"));
  const saved = await store.save({
    label: "Build host",
    transport: "ssh",
    sshTarget: "build@example.test",
    remotePort: DEFAULT_REMOTE_BACKEND_PORT,
    remoteCommand: "aldunis-code",
  });
  assert.equal(saved.pairingUrl, null);
  await store.updateRuntime(saved.record.id, { paired: true, preferredLocalPort: 49152 });
  const restarted = await new RemoteEnvironmentStore(join(directory, "connections.v1.json")).list();
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0]?.paired, true);
  assert.equal(restarted[0]?.preferredLocalPort, 49152);
  const stored = await readFile(join(directory, "connections.v1.json"), "utf8");
  assert.equal(stored.includes("pair="), false);
});

test("remote environment updates replace the record when pairing an existing endpoint again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-environments-"));
  const store = new RemoteEnvironmentStore(join(directory, "connections.v1.json"));
  const first = await store.save({
    label: "Tailnet host",
    transport: "endpoint",
    endpoint: "https://code.example.test",
    pairingUrl: "https://code.example.test/#pair=abcdefghijklmnopqrstuvwxyz0123456789_-",
  });
  assert.equal(first.record.paired, false);
  const second = await store.save({
    id: first.record.id,
    label: "Tailnet host",
    transport: "endpoint",
    endpoint: "https://code.example.test",
    pairingUrl: "https://code.example.test/#pair=ZYXWVUTSRQPONMLKJIHGFEDCBA987654321_-",
  });
  assert.equal(second.record.id, first.record.id);
  assert.equal(second.record.paired, false);
  assert.equal((await store.list()).length, 1);
  assert.equal((await readFile(join(directory, "connections.v1.json"), "utf8")).includes("ZYXWV"), false);
});

test("remote environment store rejects incompatible persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-environments-"));
  const path = join(directory, "connections.v1.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify({ schemaVersion: 99 })));
  await assert.rejects(() => new RemoteEnvironmentStore(path).list(), /corrupt or incompatible/);
});
