import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS,
  MAX_REMOTE_DESCRIPTOR_BYTES,
  normalizeRemoteEnvironmentInput,
  RemoteEnvironmentManager,
  RemoteEnvironmentStore,
  assertSshRemoteDescriptor,
  readRemoteDescriptor,
  terminateRemoteChild,
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
    () =>
      normalizeRemoteEnvironmentInput({
        label: "unsafe",
        transport: "endpoint",
        endpoint: "http://192.168.1.20:4174",
      }),
    /HTTPS origins/,
  );
  assert.throws(
    () =>
      normalizeRemoteEnvironmentInput({
        label: "unsafe",
        transport: "ssh",
        sshTarget: "prod; touch ~/.ssh/authorized_keys",
      }),
    /SSH targets/,
  );
  assert.deepEqual(
    buildSshForwardArguments("dev@example.test", 49152, DEFAULT_REMOTE_BACKEND_PORT),
    [
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=30",
      "-L",
      "127.0.0.1:49152:127.0.0.1:4177",
      "dev@example.test",
    ],
  );
  assert.deepEqual(
    buildSshServerArguments(
      "dev@example.test",
      "/opt/bin/aldunis-code",
      DEFAULT_REMOTE_BACKEND_PORT,
    ),
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      "dev@example.test",
      "/opt/bin/aldunis-code",
      "serve",
      "--remote",
      "ssh",
      "--host",
      "127.0.0.1",
      "--port",
      "4177",
    ],
  );
  assert.deepEqual(buildSshPairingArguments("dev@example.test", "/opt/bin/aldunis-code"), [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "dev@example.test",
    "/opt/bin/aldunis-code",
    "auth",
    "pairing",
    "create",
  ]);
});

test("SSH connections require the authenticated remote descriptor", () => {
  assert.doesNotThrow(() => assertSshRemoteDescriptor({ remoteEnabled: true }));
  assert.throws(
    () => assertSshRemoteDescriptor({ remoteEnabled: false }),
    /did not enable authenticated remote access/,
  );
});

test("remote descriptor reads reject declared and streamed overflow", async () => {
  assert.deepEqual(await readRemoteDescriptor(new Response('{"remoteEnabled":true}')), {
    remoteEnabled: true,
  });
  await assert.rejects(
    readRemoteDescriptor(
      new Response("{}", {
        headers: { "content-length": String(MAX_REMOTE_DESCRIPTOR_BYTES + 1) },
      }),
    ),
    /exceeds the 16 KiB limit/,
  );
  await assert.rejects(
    readRemoteDescriptor(new Response(new Uint8Array(MAX_REMOTE_DESCRIPTOR_BYTES + 1))),
    /exceeds the 16 KiB limit/,
  );
});

test("remote child termination force-stops a process that ignores SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-child-"));
  const executable = join(directory, "stubborn-child");
  const pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);
  const child = spawn(executable, [], { stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(pidPath, "utf8");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const pid = Number(await readFile(pidPath, "utf8"));
  const isAlive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  await terminateRemoteChild(child, 25);
  try {
    assert.equal(isAlive(), false);
    const startedAt = Date.now();
    await terminateRemoteChild(child, 1_000);
    assert.ok(Date.now() - startedAt < 50);
  } finally {
    if (isAlive()) process.kill(pid, "SIGKILL");
  }
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
  assert.equal(
    (await readFile(join(directory, "connections.v1.json"), "utf8")).includes("ZYXWV"),
    false,
  );
});

test("remote environment connection admission is bounded and recovers after disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-connection-capacity-"));
  const store = new RemoteEnvironmentStore(join(directory, "connections.v1.json"));
  const records = [];
  for (let index = 0; index <= MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS; index += 1) {
    records.push(
      (
        await store.save({
          label: `Endpoint ${index}`,
          transport: "endpoint",
          endpoint: `https://code-${index}.example.test`,
          pairingUrl: `https://code-${index}.example.test/#pair=abcdefghijklmnopqrstuvwxyz${index}0123456789_-`,
        })
      ).record,
    );
  }
  const manager = new RemoteEnvironmentManager(store);

  try {
    for (const record of records.slice(0, MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS)) {
      await manager.connect(
        record.id,
        `${record.endpoint}/#pair=abcdefghijklmnopqrstuvwxyz${records.indexOf(record)}0123456789_-`,
      );
    }
    await assert.rejects(
      () =>
        manager.connect(
          records[MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS]!.id,
          `${records[MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS]!.endpoint}/#pair=abcdefghijklmnopqrstuvwxyz${MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS}0123456789_-`,
        ),
      /Too many remote environments/,
    );

    await manager.disconnect(records[0]!.id);
    const admitted = await manager.connect(
      records[MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS]!.id,
      `${records[MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS]!.endpoint}/#pair=abcdefghijklmnopqrstuvwxyz${MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS}0123456789_-`,
    );
    assert.equal(admitted.id, records[MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS]!.id);
  } finally {
    await manager.close();
  }
});

test("connecting environments count once after publishing active transport", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-overlap-capacity-"));
  const store = new RemoteEnvironmentStore(join(directory, "connections.v1.json"));
  const records = [];
  for (let index = 0; index < 5; index += 1) {
    records.push(
      (
        await store.save({
          label: `Overlapping endpoint ${index}`,
          transport: "endpoint",
          endpoint: `https://overlap-${index}.example.test`,
          pairingUrl: `https://overlap-${index}.example.test/#pair=abcdefghijklmnopqrstuvwxyz${index}0123456789_-`,
        })
      ).record,
    );
  }
  const originalUpdateRuntime = store.updateRuntime.bind(store);
  let releaseUpdates!: () => void;
  const updatesReleased = new Promise<void>((resolve) => {
    releaseUpdates = resolve;
  });
  context.mock.method(store, "updateRuntime", async (...args) => {
    await updatesReleased;
    return originalUpdateRuntime(...args);
  });
  const manager = new RemoteEnvironmentManager(store);
  const connectRecord = (record: (typeof records)[number], index: number) =>
    manager.connect(
      record.id,
      `${record.endpoint}/#pair=abcdefghijklmnopqrstuvwxyz${index}0123456789_-`,
    );

  const firstFour = records.slice(0, 4).map(connectRecord);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const connected = (await manager.list()).filter((record) => record.connected).length;
    if (connected === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await manager.list()).filter((record) => record.connected).length, 4);
  const fifth = connectRecord(records[4]!, 4);
  let rejected = false;
  void fifth.catch(() => {
    rejected = true;
  });
  await Promise.resolve();
  assert.equal(rejected, false);
  releaseUpdates();
  await Promise.all([...firstFour, fifth]);
  await manager.close();
});

test("concurrent connection requests for one environment share admission", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-connection-coalesce-"));
  const store = new RemoteEnvironmentStore(join(directory, "connections.v1.json"));
  const saved = await store.save({
    label: "Shared endpoint",
    transport: "endpoint",
    endpoint: "https://shared.example.test",
    pairingUrl: "https://shared.example.test/#pair=abcdefghijklmnopqrstuvwxyz0123456789_-",
  });
  const originalList = store.list.bind(store);
  let listCalls = 0;
  context.mock.method(store, "list", async () => {
    listCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return originalList();
  });
  const manager = new RemoteEnvironmentManager(store);
  const pairingUrl = "https://shared.example.test/#pair=abcdefghijklmnopqrstuvwxyz0123456789_-";

  try {
    const first = manager.connect(saved.record.id, pairingUrl);
    const second = manager.connect(saved.record.id, pairingUrl);
    assert.equal(first, second);
    await assert.rejects(
      () => manager.connect(saved.record.id, pairingUrl, true),
      /different connection request is already active/,
    );
    assert.deepEqual(await Promise.all([first, second]), [await first, await first]);
    // One public preflight read. Runtime mutation reloads the complete recovery
    // inventory internally so it cannot truncate a legacy overflow.
    assert.equal(listCalls, 1);
  } finally {
    await manager.close();
  }
});

test("disconnect keeps reconnect blocked until a connecting lifecycle is drained", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-disconnect-barrier-"));
  const store = new RemoteEnvironmentStore(join(directory, "connections.v1.json"));
  const saved = await store.save({
    label: "Disconnecting endpoint",
    transport: "endpoint",
    endpoint: "https://disconnecting.example.test",
    pairingUrl: "https://disconnecting.example.test/#pair=abcdefghijklmnopqrstuvwxyz0123456789_-",
  });
  const originalList = store.list.bind(store);
  context.mock.method(store, "list", async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return originalList();
  });
  const manager = new RemoteEnvironmentManager(store);
  const pairingUrl =
    "https://disconnecting.example.test/#pair=abcdefghijklmnopqrstuvwxyz0123456789_-";

  const connecting = manager.connect(saved.record.id, pairingUrl);
  const disconnecting = manager.disconnect(saved.record.id);
  await assert.rejects(() => manager.connect(saved.record.id, pairingUrl), /still disconnecting/);
  await Promise.all([connecting, disconnecting]);
  assert.equal((await manager.list()).find(({ id }) => id === saved.record.id)?.connected, false);
});

test("remote environment store rejects incompatible persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-environments-"));
  const path = join(directory, "connections.v1.json");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, JSON.stringify({ schemaVersion: 99 })),
  );
  await assert.rejects(() => new RemoteEnvironmentStore(path).list(), /corrupt or incompatible/);
});
