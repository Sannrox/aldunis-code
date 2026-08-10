import assert from "node:assert/strict";
import test from "node:test";
import {
  clearThreadScrollPosition,
  parseThreadScrollPositionMap,
  pruneThreadScrollPositionMap,
  readThreadScrollPosition,
  restoreThreadScrollTop,
  shouldRestoreThreadScrollOnOpen,
  snapshotThreadScroll,
  writeThreadScrollPosition,
  type ThreadScrollSnapshot,
} from "./thread-open-scroll";

test("shouldRestoreThreadScrollOnOpen only when remember and not following", () => {
  const mid: ThreadScrollSnapshot = {
    following: false,
    scrollTop: 120,
    clientHeight: 400,
    scrollHeight: 1200,
    updatedAt: 1,
  };
  assert.equal(shouldRestoreThreadScrollOnOpen("latest", mid), false);
  assert.equal(shouldRestoreThreadScrollOnOpen("remember", null), false);
  assert.equal(shouldRestoreThreadScrollOnOpen("remember", { ...mid, following: true }), false);
  assert.equal(shouldRestoreThreadScrollOnOpen("remember", mid), true);
});

test("restoreThreadScrollTop pins following snapshots to the tail", () => {
  const target = { scrollTop: 0, clientHeight: 400, scrollHeight: 1000 };
  restoreThreadScrollTop(target, {
    following: true,
    scrollTop: 10,
    clientHeight: 400,
    scrollHeight: 800,
    updatedAt: 1,
  });
  assert.equal(target.scrollTop, 1000);
});

test("restoreThreadScrollTop maps mid-thread places by ratio", () => {
  const target = { scrollTop: 0, clientHeight: 400, scrollHeight: 1400 };
  // Previous max = 600, scrollTop 300 => 0.5; current max = 1000 => 500
  restoreThreadScrollTop(target, {
    following: false,
    scrollTop: 300,
    clientHeight: 400,
    scrollHeight: 1000,
    updatedAt: 1,
  });
  assert.equal(target.scrollTop, 500);
});

test("snapshotThreadScroll records a durable place", () => {
  assert.deepEqual(
    snapshotThreadScroll({
      scrollTop: 40,
      clientHeight: 300,
      scrollHeight: 900,
      following: false,
      now: 99,
    }),
    {
      following: false,
      scrollTop: 40,
      clientHeight: 300,
      scrollHeight: 900,
      updatedAt: 99,
    },
  );
});

test("thread scroll position storage round-trips and prunes by recency", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  writeThreadScrollPosition(
    "c1",
    snapshotThreadScroll({
      scrollTop: 10,
      clientHeight: 100,
      scrollHeight: 400,
      following: false,
      now: 1,
    }),
    storage,
  );
  writeThreadScrollPosition(
    "c2",
    snapshotThreadScroll({
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 100,
      following: true,
      now: 2,
    }),
    storage,
  );

  assert.equal(readThreadScrollPosition("c1", storage)?.scrollTop, 10);
  assert.equal(readThreadScrollPosition("c2", storage)?.following, true);

  const pruned = pruneThreadScrollPositionMap(
    parseThreadScrollPositionMap(storage.getItem("aldunis.thread.scrollPositions.v1")),
    1,
  );
  assert.deepEqual(Object.keys(pruned), ["c2"]);

  clearThreadScrollPosition("c2", storage);
  assert.equal(readThreadScrollPosition("c2", storage), null);
});

test("parseThreadScrollPositionMap rejects malformed entries", () => {
  assert.deepEqual(parseThreadScrollPositionMap("not-json"), {});
  assert.deepEqual(parseThreadScrollPositionMap('{"x":{"following":"no"}}'), {});
  assert.deepEqual(
    parseThreadScrollPositionMap(
      JSON.stringify({
        ok: {
          following: false,
          scrollTop: 1,
          clientHeight: 2,
          scrollHeight: 3,
          updatedAt: 4,
        },
      }),
    ).ok?.scrollTop,
    1,
  );
});
