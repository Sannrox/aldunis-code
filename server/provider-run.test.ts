import assert from "node:assert/strict";
import test from "node:test";
import {
  admitProviderRun,
  createProviderRunSink,
  handleProviderRun,
  MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS,
  MAX_ACTIVE_PROVIDER_RUNS,
  ProviderInputExpiryTimers,
  ProviderRunAdmission,
  shouldReleaseBrowserProviderToken,
  type ProviderRunModuleContext,
  type ProviderRunOutput,
} from "./provider-run.ts";
import { RepositoryError } from "./repository.ts";

const output = {} as ProviderRunOutput;

class FakeInputTimers {
  readonly pending = new Set<{ callback: () => void; unref(): void }>();
  setTimeout(callback: () => void): { callback: () => void; unref(): void } {
    const timer = { callback, unref() {} };
    this.pending.add(timer);
    return timer;
  }
  clearTimeout(timer: { callback: () => void; unref(): void }): void {
    this.pending.delete(timer);
  }
  fire(timer: { callback: () => void; unref(): void }): void {
    if (!this.pending.delete(timer)) return;
    timer.callback();
  }
}

test("provider input expiry timers release on answer, replacement, firing, and run close", () => {
  const timers = new FakeInputTimers();
  const expiry = new ProviderInputExpiryTimers(timers);
  let fired = 0;
  expiry.schedule("run-1", "input-1", new Date(Date.now() + 60_000).toISOString(), () => {
    fired += 1;
  });
  const replaced = [...timers.pending][0]!;
  expiry.schedule("run-1", "input-1", new Date(Date.now() + 60_000).toISOString(), () => {
    fired += 1;
  });
  assert.equal(timers.pending.has(replaced), false);
  replaced.callback();
  assert.equal(fired, 0);
  assert.equal(expiry.retainedTimerCount, 1);
  assert.equal(expiry.clear("run-1", "input-1"), true);
  assert.equal(expiry.retainedTimerCount, 0);

  expiry.schedule("run-1", "input-1", new Date(Date.now() + 60_000).toISOString(), () => {
    fired += 1;
  });
  const active = [...timers.pending][0]!;
  timers.fire(active);
  assert.equal(fired, 1);
  assert.equal(expiry.retainedTimerCount, 0);
  assert.equal(expiry.clear("run-1", "input-1"), false);

  expiry.schedule("run-1", "input-1", new Date(Date.now() + 60_000).toISOString(), () => {});
  expiry.schedule("run-1", "input-2", new Date(Date.now() + 60_000).toISOString(), () => {});
  expiry.clearRun("run-1");
  assert.equal(expiry.retainedTimerCount, 0);
  assert.equal(timers.pending.size, 0);
});

test("provider input expiry timers bound admission and recover capacity", () => {
  const timers = new FakeInputTimers();
  const expiry = new ProviderInputExpiryTimers(timers);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  for (let index = 0; index < MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS; index += 1) {
    expiry.schedule(`run-${index % 2}`, `input-${index}`, expiresAt, () => {});
  }
  assert.equal(expiry.retainedTimerCount, MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS);
  assert.equal(timers.pending.size, MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS);

  const replaced = [...timers.pending][0]!;
  expiry.schedule("run-0", "input-0", expiresAt, () => {});
  assert.equal(timers.pending.has(replaced), false);
  assert.equal(expiry.retainedTimerCount, MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS);
  assert.throws(
    () => expiry.schedule("run-overflow", "input-overflow", expiresAt, () => {}),
    /Too many provider input requests are awaiting expiry/,
  );
  assert.equal(timers.pending.size, MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS);

  assert.equal(expiry.clear("run-1", "input-1"), true);
  expiry.schedule("run-recovered", "input-recovered", expiresAt, () => {});
  assert.equal(expiry.retainedTimerCount, MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS);

  const active = [...timers.pending][0]!;
  timers.fire(active);
  assert.equal(expiry.retainedTimerCount, MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS - 1);
  expiry.schedule("run-fired", "input-fired", expiresAt, () => {});
  expiry.clearRun("run-0");
  assert.ok(expiry.retainedTimerCount < MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS);
});

test("browser provider token release follows accepted Codex session ownership", () => {
  assert.equal(shouldReleaseBrowserProviderToken("codex-cli", false), true);
  assert.equal(shouldReleaseBrowserProviderToken("codex-cli", true), false);
  assert.equal(shouldReleaseBrowserProviderToken("claude-code", false), true);
});

test("provider run admission bounds host-wide execution and releases idempotently", () => {
  const admission = new ProviderRunAdmission();
  const releases = Array.from({ length: MAX_ACTIVE_PROVIDER_RUNS }, () => admission.acquire());
  assert.equal(admission.retainedLeaseCount, MAX_ACTIVE_PROVIDER_RUNS);
  assert.throws(
    () => admission.acquire(),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 429 &&
      error.message === "Too many provider runs are active.",
  );
  assert.equal(admission.retainedLeaseCount, MAX_ACTIVE_PROVIDER_RUNS);

  releases[0]!();
  releases[0]!();
  const recovered = admission.acquire();
  assert.equal(admission.retainedLeaseCount, MAX_ACTIVE_PROVIDER_RUNS);
  recovered();
  for (const release of releases.slice(1)) release();
  assert.equal(admission.retainedLeaseCount, 0);
});

function moduleContext(
  overrides: Partial<ProviderRunModuleContext> = {},
): ProviderRunModuleContext {
  return {
    internalRequest: false,
    remoteRequest: false,
    activeCheckpointProjects: new Set(),
    activeCheckpointWorktrees: new Set(),
    providerRunAdmission: new ProviderRunAdmission(),
    inputExpiryTimers: new ProviderInputExpiryTimers(),
    checkpointWorktreeKey: (projectId, worktree) => JSON.stringify([projectId, worktree]),
    selectedWorktree: async (root, worktree) => ({ root, worktree }),
    ...overrides,
  } as ProviderRunModuleContext;
}

test("run admission rejects incomplete input before touching provider dependencies", async () => {
  const providerRunAdmission = new ProviderRunAdmission();
  await assert.rejects(
    handleProviderRun(
      { body: { root: "/repo", worktree: "/repo", prompt: "Inspect" } },
      output,
      moduleContext({
        providerRunAdmission,
        selectedWorktree: async () => {
          throw new Error("workspace selection must not run");
        },
      }),
    ),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 400 &&
      error.message.includes("interaction mode, provider, and model"),
  );
  assert.equal(providerRunAdmission.retainedLeaseCount, 0);
});

test("provider run overflow fails before workspace or local execution work", async () => {
  const providerRunAdmission = new ProviderRunAdmission();
  const releases = Array.from({ length: MAX_ACTIVE_PROVIDER_RUNS }, () =>
    providerRunAdmission.acquire(),
  );
  let selected = false;
  await assert.rejects(
    handleProviderRun(
      {
        body: {
          root: "/repo",
          worktree: "/repo",
          prompt: "Inspect",
          conversationId: "conversation-1",
          mode: "ask",
          provider: "codex-cli",
          model: "gpt-5.6",
        },
      },
      output,
      moduleContext({
        providerRunAdmission,
        selectedWorktree: async (root, worktree) => {
          selected = true;
          return { root, worktree };
        },
      }),
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 429,
  );
  assert.equal(selected, false);
  assert.equal(providerRunAdmission.retainedLeaseCount, MAX_ACTIVE_PROVIDER_RUNS);
  for (const release of releases) release();
});

test("typed admission reports the same rejection to acceptance and completion callers", async () => {
  const execution = admitProviderRun(
    { body: { root: "/repo", worktree: "/repo", prompt: "Inspect" } },
    createProviderRunSink(),
    moduleContext(),
  );

  await assert.rejects(
    execution.accepted,
    (error: unknown) => error instanceof RepositoryError && error.status === 400,
  );
  await assert.rejects(
    execution.completed,
    (error: unknown) => error instanceof RepositoryError && error.status === 400,
  );
});

test("run admission rejects automation authority from external requests", async () => {
  await assert.rejects(
    handleProviderRun(
      {
        body: {
          root: "/repo",
          worktree: "/repo",
          prompt: "Inspect",
          conversationId: "conversation-1",
          mode: "ask",
          provider: "codex-cli",
          model: "gpt-5.6",
          automationFireId: "48cb0790-05b2-4b20-9baf-9d05e6852e92",
        },
      },
      output,
      moduleContext(),
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 400,
  );
});

test("remote run admission rejects folder context before filesystem assembly", async () => {
  let selected = false;
  await assert.rejects(
    handleProviderRun(
      {
        body: {
          root: "/repo",
          worktree: "/repo",
          prompt: "Inspect",
          conversationId: "conversation-1",
          mode: "ask",
          provider: "codex-cli",
          model: "gpt-5.6",
          contextPins: [{ path: "src", kind: "folder" }],
        },
      },
      output,
      moduleContext({
        remoteRequest: true,
        selectedWorktree: async (root, worktree) => {
          selected = true;
          return { root, worktree };
        },
      }),
    ),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 403 &&
      error.message.includes("Remote folder pinning"),
  );
  assert.equal(selected, true);
});
