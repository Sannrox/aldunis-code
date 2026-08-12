import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  assertPreviewOrigin,
  hasPendingPreviewTermination,
  MAX_RETAINED_PREVIEW_SESSIONS,
  PreviewError,
  PreviewManager,
  releasePreviewTerminationAttempt,
  terminatePreviewProcess,
  type PreviewTerminationRuntime,
} from "./preview.ts";

interface TestTimer {
  callback: () => void;
  cleared: boolean;
  unref(): void;
}

function previewTerminationFixture(options: { exited?: boolean; pid?: number } = {}) {
  const events = new EventEmitter();
  const directSignals: NodeJS.Signals[] = [];
  const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const windowsTrees: number[] = [];
  const timers: TestTimer[] = [];
  const child = Object.assign(events, {
    exitCode: options.exited ? 0 : null,
    signalCode: null,
    pid: options.pid ?? 4242,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      directSignals.push(signal);
      return true;
    },
  }) as unknown as ChildProcess;
  const runtime: PreviewTerminationRuntime = {
    platform: "darwin",
    setTimeout(callback) {
      const timer: TestTimer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      (timer as TestTimer).cleared = true;
    },
    killProcessGroup(pid, signal) {
      groupSignals.push({ pid, signal });
    },
    killWindowsTree(pid) {
      windowsTrees.push(pid);
    },
  };
  return { child, directSignals, groupSignals, runtime, timers, windowsTrees };
}

test("preview origins are loopback-only and credentials are rejected", () => {
  assert.equal(assertPreviewOrigin("http://localhost:4173/app"), "http://localhost:4173");
  assert.equal(assertPreviewOrigin("https://127.0.0.1:8443"), "https://127.0.0.1:8443");
  for (const value of [
    "https://example.com",
    "file:///tmp/index.html",
    "http://user:pass@localhost:4173",
  ]) {
    assert.throws(
      () => assertPreviewOrigin(value),
      (error: unknown) => error instanceof PreviewError && error.status === 403,
    );
  }
});

test("preview termination clears its exact force timer on normal exit", () => {
  const fixture = previewTerminationFixture();
  terminatePreviewProcess(fixture.child, fixture.runtime);
  terminatePreviewProcess(fixture.child, fixture.runtime);
  assert.deepEqual(fixture.groupSignals, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.equal(fixture.timers.length, 1);
  assert.equal(hasPendingPreviewTermination(fixture.child), true);

  fixture.child.exitCode = 0;
  fixture.child.emit("exit", 0, null);
  assert.equal(fixture.timers[0]?.cleared, true);
  assert.equal(hasPendingPreviewTermination(fixture.child), false);
});

test("preview termination force-kills once and remains idempotent until close", () => {
  const fixture = previewTerminationFixture();
  terminatePreviewProcess(fixture.child, fixture.runtime);
  fixture.timers[0]?.callback();
  terminatePreviewProcess(fixture.child, fixture.runtime);
  assert.deepEqual(fixture.groupSignals, [
    { pid: 4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGKILL" },
  ]);
  assert.equal(hasPendingPreviewTermination(fixture.child), true);

  fixture.child.signalCode = "SIGKILL";
  fixture.child.emit("close", null, "SIGKILL");
  assert.equal(hasPendingPreviewTermination(fixture.child), false);
});

test("a timed-out preview termination attempt releases a fresh retry", () => {
  const fixture = previewTerminationFixture();
  terminatePreviewProcess(fixture.child, fixture.runtime);
  fixture.timers[0]?.callback();
  releasePreviewTerminationAttempt(fixture.child);
  assert.equal(hasPendingPreviewTermination(fixture.child), false);

  terminatePreviewProcess(fixture.child, fixture.runtime);
  assert.deepEqual(fixture.groupSignals, [
    { pid: 4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGKILL" },
    { pid: 4242, signal: "SIGTERM" },
  ]);
  assert.equal(fixture.timers.length, 2);
  fixture.child.emit("close", null, null);
});

test("preview termination retains nothing for an already-exited child", () => {
  const fixture = previewTerminationFixture({ exited: true });
  terminatePreviewProcess(fixture.child, fixture.runtime);
  assert.deepEqual(fixture.groupSignals, []);
  assert.deepEqual(fixture.directSignals, []);
  assert.deepEqual(fixture.timers, []);
  assert.equal(hasPendingPreviewTermination(fixture.child), false);
});

test("preview termination preserves one Windows tree-kill lifecycle", () => {
  const fixture = previewTerminationFixture();
  fixture.runtime.platform = "win32";
  terminatePreviewProcess(fixture.child, fixture.runtime);
  terminatePreviewProcess(fixture.child, fixture.runtime);
  assert.deepEqual(fixture.windowsTrees, [4242]);
  assert.deepEqual(fixture.groupSignals, []);
  assert.deepEqual(fixture.timers, []);
  assert.equal(hasPendingPreviewTermination(fixture.child), true);

  fixture.child.emit("close", 1, null);
  assert.equal(hasPendingPreviewTermination(fixture.child), false);
});

test("preview start approval is scoped, exact, and single-use", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-"));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({
      scripts: { dev: 'node -e "setTimeout(() => {}, 10000)"' },
    }),
  );
  const manager = new PreviewManager();
  const pending = await manager.requestStart("/repo", worktree, "http://localhost:4173");
  assert.equal(pending.command, "npm run dev");
  assert.equal(pending.state, "approval_pending");
  assert.throws(
    () => manager.decide(pending.id, { repository: "/repo", worktree: "/other" }, "allow_once"),
    (error: unknown) => error instanceof PreviewError && error.status === 403,
  );
  const denied = manager.decide(pending.id, { repository: "/repo", worktree }, "deny");
  assert.equal(denied.state, "stopped");
  // Terminal previews are released so the manager does not retain every past session.
  assert.throws(
    () => manager.decide(pending.id, { repository: "/repo", worktree }, "allow_once"),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
  assert.throws(
    () => manager.snapshot(pending.id),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
});

test("preview admission bounds retained sessions and recovers released capacity", async () => {
  const worktrees: string[] = [];
  const manager = new PreviewManager();

  try {
    for (let index = 0; index <= MAX_RETAINED_PREVIEW_SESSIONS; index += 1) {
      const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-capacity-"));
      await writeFile(
        join(worktree, "package.json"),
        JSON.stringify({ scripts: { dev: 'node -e "setTimeout(() => {}, 10000)"' } }),
      );
      worktrees.push(worktree);
    }

    const pending = [];
    for (const worktree of worktrees.slice(0, MAX_RETAINED_PREVIEW_SESSIONS)) {
      pending.push(await manager.requestStart("/repo", worktree, "http://localhost:4173"));
    }
    await assert.rejects(
      () =>
        manager.requestStart(
          "/repo",
          worktrees[MAX_RETAINED_PREVIEW_SESSIONS]!,
          "http://localhost:4173",
        ),
      (error: unknown) => error instanceof PreviewError && error.status === 429,
    );

    manager.decide(pending[0]!.id, { repository: "/repo", worktree: worktrees[0]! }, "deny");
    const admitted = await manager.requestStart(
      "/repo",
      worktrees[MAX_RETAINED_PREVIEW_SESSIONS]!,
      "http://localhost:4173",
    );
    assert.equal(admitted.state, "approval_pending");
  } finally {
    await manager.stopAll();
  }
});

test("preview admission preserves terminal visibility until capacity pressure", async () => {
  const manager = new PreviewManager();
  const worktrees: string[] = [];

  try {
    for (let index = 0; index <= MAX_RETAINED_PREVIEW_SESSIONS; index += 1) {
      const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-terminal-capacity-"));
      await writeFile(
        join(worktree, "package.json"),
        JSON.stringify({
          scripts: {
            dev:
              index === 0 ? 'node -e "process.exit(1)"' : 'node -e "setTimeout(() => {}, 10000)"',
          },
        }),
      );
      worktrees.push(worktree);
    }

    const terminal = await manager.requestStart("/repo", worktrees[0]!, "http://localhost:4173");
    manager.decide(terminal.id, { repository: "/repo", worktree: worktrees[0]! }, "allow_once");
    let snapshot = manager.snapshot(terminal.id);
    for (
      let attempt = 0;
      attempt < 50 && (snapshot.state === "starting" || snapshot.state === "running");
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = manager.snapshot(terminal.id);
    }
    assert.equal(snapshot.state, "failed");

    for (const worktree of worktrees.slice(1, MAX_RETAINED_PREVIEW_SESSIONS)) {
      await manager.requestStart("/repo", worktree, "http://localhost:4173");
      assert.equal(manager.snapshot(terminal.id).state, "failed");
    }
    await manager.requestStart(
      "/repo",
      worktrees[MAX_RETAINED_PREVIEW_SESSIONS]!,
      "http://localhost:4173",
    );
    assert.throws(
      () => manager.snapshot(terminal.id),
      (error: unknown) => error instanceof PreviewError && error.status === 404,
    );
  } finally {
    await manager.stopAll();
  }
});

test("capacity eviction cancels the terminal retention timer", async (context) => {
  const manager = new PreviewManager();
  const worktrees: string[] = [];
  const terminalTimers = new Set<NodeJS.Timeout>();
  const clearedTerminalTimers = new Set<NodeJS.Timeout>();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  context.mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 60_000) terminalTimers.add(timer);
    return timer;
  }) as typeof setTimeout);
  context.mock.method(globalThis, "clearTimeout", ((timer: NodeJS.Timeout) => {
    if (terminalTimers.has(timer)) clearedTerminalTimers.add(timer);
    originalClearTimeout(timer);
  }) as typeof clearTimeout);

  try {
    for (let index = 0; index <= MAX_RETAINED_PREVIEW_SESSIONS; index += 1) {
      const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-timer-capacity-"));
      await writeFile(
        join(worktree, "package.json"),
        JSON.stringify({
          scripts: {
            dev:
              index === 0 ? 'node -e "process.exit(1)"' : 'node -e "setTimeout(() => {}, 10000)"',
          },
        }),
      );
      worktrees.push(worktree);
    }

    const terminal = await manager.requestStart("/repo", worktrees[0]!, "http://localhost:4173");
    manager.decide(terminal.id, { repository: "/repo", worktree: worktrees[0]! }, "allow_once");
    let snapshot = manager.snapshot(terminal.id);
    for (
      let attempt = 0;
      attempt < 50 && (snapshot.state === "starting" || snapshot.state === "running");
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = manager.snapshot(terminal.id);
    }
    assert.equal(snapshot.state, "failed");
    for (const worktree of worktrees.slice(1, MAX_RETAINED_PREVIEW_SESSIONS)) {
      await manager.requestStart("/repo", worktree, "http://localhost:4173");
    }
    assert.equal(terminalTimers.size, 1);
    assert.equal(clearedTerminalTimers.size, 0);

    await manager.requestStart(
      "/repo",
      worktrees[MAX_RETAINED_PREVIEW_SESSIONS]!,
      "http://localhost:4173",
    );
    assert.deepEqual(clearedTerminalTimers, terminalTimers);
  } finally {
    await manager.stopAll();
  }
});

test("missing development scripts fail visibly", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-"));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({ scripts: { test: "node test" } }),
  );
  await assert.rejects(
    () => new PreviewManager().requestStart("/repo", worktree, "http://localhost:4173"),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
});

test("approved previews become available and stop explicitly", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-"));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({
      scripts: {
        dev: `node -e "require('http').createServer((q,s)=>s.end('ready')).listen(${port},'127.0.0.1')"`,
      },
    }),
  );
  const manager = new PreviewManager();
  const pending = await manager.requestStart("/repo", worktree, `http://127.0.0.1:${port}`);
  manager.decide(pending.id, { repository: "/repo", worktree }, "allow_once");
  let snapshot = manager.snapshot(pending.id);
  for (let attempt = 0; attempt < 50 && snapshot.state === "starting"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = manager.snapshot(pending.id);
  }
  assert.equal(snapshot.state, "running");
  assert.equal(
    (await manager.stop(pending.id, { repository: "/repo", worktree })).state,
    "stopped",
  );
  assert.throws(
    () => manager.snapshot(pending.id),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
});

test("stopAll terminates active previews so host shutdown cannot retain them", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-stopall-"));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({
      scripts: {
        dev: `node -e "require('http').createServer((q,s)=>s.end('ready')).listen(${port},'127.0.0.1'); setInterval(()=>{}, 60000)"`,
      },
    }),
  );
  const manager = new PreviewManager();
  const pending = await manager.requestStart("/repo", worktree, `http://127.0.0.1:${port}`);
  manager.decide(pending.id, { repository: "/repo", worktree }, "allow_once");
  let snapshot = manager.snapshot(pending.id);
  for (let attempt = 0; attempt < 50 && snapshot.state === "starting"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = manager.snapshot(pending.id);
  }
  assert.equal(snapshot.state, "running");
  await manager.stopAll();
  assert.throws(
    () => manager.snapshot(pending.id),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
});
