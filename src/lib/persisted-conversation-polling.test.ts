import assert from "node:assert/strict";
import test from "node:test";
import {
  PERSISTED_CONVERSATION_POLL_INTERVAL_MS,
  PERSISTED_CONVERSATION_RETRY_INTERVAL_MS,
  startPersistedConversationPolling,
} from "./persisted-conversation-polling";

function fixture(initial: DocumentVisibilityState = "visible") {
  let visibilityState = initial;
  let listener: (() => void) | null = null;
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  return {
    visibility: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type: "visibilitychange", next: () => void) => {
        listener = next;
      },
      removeEventListener: () => {
        listener = null;
      },
    },
    timers: {
      setTimeout(callback: () => void, delay: number) {
        const id = nextId++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
    pending: timers,
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      listener?.();
    },
    fireTimer() {
      const [id, timer] = [...timers.entries()][0]!;
      timers.delete(id);
      timer.callback();
    },
  };
}

test("history polling pauses while hidden without background notifications", async () => {
  const current = fixture("hidden");
  let refreshes = 0;
  const stop = startPersistedConversationPolling(
    async () => {
      refreshes += 1;
      return true;
    },
    { background: false },
    current.visibility,
    current.timers,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.equal(current.pending.size, 0);

  current.setVisibility("visible");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 2);
  assert.deepEqual(
    [...current.pending.values()].map((timer) => timer.delay),
    [PERSISTED_CONVERSATION_POLL_INTERVAL_MS],
  );
  stop();
});

test("visibility refreshes preserve one serialized polling chain", async () => {
  const current = fixture();
  const releases: Array<() => void> = [];
  let refreshes = 0;
  const stop = startPersistedConversationPolling(
    () =>
      new Promise<boolean>((resolve) => {
        refreshes += 1;
        releases.push(() => resolve(true));
      }),
    { background: false },
    current.visibility,
    current.timers,
  );
  current.setVisibility("hidden");
  current.setVisibility("visible");
  current.setVisibility("visible");
  assert.equal(refreshes, 1);
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 2);
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(current.pending.size, 1);
  stop();
});

test("background attention polling and retry remain bounded", async () => {
  const current = fixture("hidden");
  let attempts = 0;
  const stop = startPersistedConversationPolling(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
      return true;
    },
    { background: true },
    current.visibility,
    current.timers,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal([...current.pending.values()][0]?.delay, PERSISTED_CONVERSATION_RETRY_INTERVAL_MS);
  current.fireTimer();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(current.pending.size, 1);
  stop();
  assert.equal(current.pending.size, 0);
});

test("cleanup prevents late refresh completion from rescheduling", async () => {
  const current = fixture();
  let release!: (value: boolean) => void;
  const stop = startPersistedConversationPolling(
    () => new Promise<boolean>((resolve) => (release = resolve)),
    { background: false },
    current.visibility,
    current.timers,
  );
  stop();
  release(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(current.pending.size, 0);
});
