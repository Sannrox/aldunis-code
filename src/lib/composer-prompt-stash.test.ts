import assert from "node:assert/strict";
import test from "node:test";
import {
  clearManagedPromptStashes,
  clearRemotePromptStashes,
  createPromptStash,
  createPromptStashEntry,
  getPromptStashBackend,
  getPromptStashStorage,
  insertStashEntry,
  matchesPromptStashShortcut,
  normalizeStashPrompt,
  parsePromptStashState,
  promptStashStorageKey,
  readPromptStash,
  readRemoteSessionIdForStash,
  removeStashEntry,
  resolvePromptStashScope,
  serializePromptStashState,
  stashEntrySnippet,
  stashPromptRejectionReason,
  writePromptStash,
  MAX_STASH_ENTRIES,
  MAX_STASH_PROMPT_CHARS,
  PROMPT_STASH_STORAGE_KEY,
  type PromptStashStorage,
} from "./composer-prompt-stash";

function memoryStorage() {
  const memory = new Map<string, string>();
  return {
    memory,
    storage: {
      getItem(key: string) {
        return memory.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        memory.set(key, value);
      },
      removeItem(key: string) {
        memory.delete(key);
      },
    },
  };
}

test("prompt stash interface owns stash, atomic swap, and remove behavior", () => {
  const { storage } = memoryStorage();
  const stash = createPromptStash("remote:session-1", { localStorage: storage });

  const empty = stash.stash("  ");
  assert.equal(empty.ok, false);
  assert.equal(empty.message, "Nothing to stash.");

  const parked = stash.stash("first prompt");
  assert.equal(parked.ok, true);
  assert.equal(parked.entries.length, 1);
  const parkedId = parked.entries[0]?.id;
  assert.ok(parkedId);

  const restored = stash.restore(parkedId, "current draft");
  assert.equal(restored.ok, true);
  assert.equal(restored.prompt, "first prompt");
  assert.equal(restored.message, "Current draft parked; stashed prompt restored.");
  assert.equal(restored.entries.length, 1);
  assert.equal(restored.entries[0]?.prompt, "current draft");

  const removed = stash.remove(restored.entries[0]!.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.entries, []);
  assert.equal(stash.remove("missing").message, "That stashed prompt is no longer available.");
});

test("prompt stash interface leaves stored drafts intact when persistence fails", () => {
  const stored = serializePromptStashState([createPromptStashEntry("safe draft", { id: "safe" })!]);
  const storage: PromptStashStorage = {
    getItem: () => stored,
    setItem() {
      throw new Error("quota");
    },
    removeItem() {},
  };
  const stash = createPromptStash("local", { localStorage: storage });

  const restore = stash.restore("safe", "replacement");
  assert.equal(restore.ok, false);
  assert.equal(restore.prompt, undefined);
  assert.equal(restore.entries[0]?.prompt, "safe draft");
  assert.equal(restore.message, "Could not update stash (storage unavailable).");
});

test("prompt stash interface keeps scopes isolated and enforces capacity", () => {
  const { storage } = memoryStorage();
  const alice = createPromptStash("remote:alice", { localStorage: storage });
  const bob = createPromptStash("remote:bob", { localStorage: storage });
  for (let index = 0; index < MAX_STASH_ENTRIES + 2; index += 1) {
    assert.equal(alice.stash(`draft ${index}`).ok, true);
  }
  assert.equal(alice.load().length, MAX_STASH_ENTRIES);
  assert.equal(bob.load().length, 0);
});

test("managed prompt stash interfaces observe account-clear lifecycle", () => {
  const alice = createPromptStash("managed:tenant:alice");
  assert.equal(alice.stash("private draft").ok, true);
  assert.equal(alice.load().length, 1);
  clearManagedPromptStashes();
  assert.equal(alice.load().length, 0);
});

test("normalizeStashPrompt rejects whitespace-only drafts", () => {
  assert.equal(normalizeStashPrompt(""), null);
  assert.equal(normalizeStashPrompt("   \n\t  "), null);
  assert.equal(normalizeStashPrompt(" ship it "), " ship it ");
});

test("normalizeStashPrompt rejects oversized prompts instead of truncating", () => {
  const huge = "x".repeat(MAX_STASH_PROMPT_CHARS + 50);
  assert.equal(normalizeStashPrompt(huge), null);
  assert.equal(createPromptStashEntry(huge), null);
});

test("insertStashEntry puts newest first and evicts past the cap", () => {
  const existing = Array.from({ length: MAX_STASH_ENTRIES }, (_, index) => ({
    id: `old-${index}`,
    createdAt: `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    prompt: `prompt ${index}`,
  }));
  const entry = createPromptStashEntry("brand new", {
    id: "new",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  assert.ok(entry);
  const { entries, evicted } = insertStashEntry(existing, entry);
  assert.equal(entries.length, MAX_STASH_ENTRIES);
  assert.equal(entries[0]?.id, "new");
  assert.equal(evicted?.id, `old-${MAX_STASH_ENTRIES - 1}`);
});

test("removeStashEntry is idempotent for missing ids", () => {
  const base = [createPromptStashEntry("one", { id: "a" })!];
  const missing = removeStashEntry(base, "missing");
  assert.equal(missing.removed, null);
  assert.equal(missing.entries.length, 1);
  const gone = removeStashEntry(base, "a");
  assert.equal(gone.removed?.id, "a");
  assert.equal(gone.entries.length, 0);
});

test("stashEntrySnippet collapses whitespace and ellipsizes", () => {
  assert.equal(
    stashEntrySnippet({ id: "1", createdAt: "t", prompt: "  hello   world  " }),
    "hello world",
  );
  const long = "word ".repeat(40).trim();
  const snippet = stashEntrySnippet({ id: "1", createdAt: "t", prompt: long });
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.length <= 91);
});

test("parse/serialize round-trip and rejects corrupt payloads", () => {
  const entries = [
    createPromptStashEntry("alpha", { id: "a", createdAt: "2026-08-01T00:00:00.000Z" })!,
    createPromptStashEntry("beta", { id: "b", createdAt: "2026-08-01T01:00:00.000Z" })!,
  ];
  const raw = serializePromptStashState(entries);
  assert.deepEqual(parsePromptStashState(raw), entries);
  assert.deepEqual(parsePromptStashState("not-json"), []);
  assert.deepEqual(parsePromptStashState('{"version":99,"entries":[]}'), []);
  assert.deepEqual(
    parsePromptStashState(
      JSON.stringify({
        version: 1,
        entries: [{ id: "x", createdAt: "t", prompt: "   " }, { bad: true }],
      }),
    ),
    [],
  );
});

test("read/writePromptStash fail soft on storage errors", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
    },
    removeItem(key: string) {
      memory.delete(key);
    },
  };
  const entry = createPromptStashEntry("parked", { id: "p" })!;
  assert.equal(writePromptStash(storage, [entry], "local"), true);
  assert.equal(memory.has(promptStashStorageKey("local")), true);
  assert.equal(memory.has(PROMPT_STASH_STORAGE_KEY), false);
  assert.deepEqual(readPromptStash(storage, "local"), [entry]);

  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {},
  };
  assert.deepEqual(readPromptStash(throwing), []);
  assert.equal(writePromptStash(throwing, [entry]), false);
  assert.deepEqual(readPromptStash(null), []);
  assert.equal(writePromptStash(null, [entry]), false);
});

test("resolvePromptStashScope prefers remote session then managed operator then local", () => {
  assert.equal(
    resolvePromptStashScope({ remoteSessionId: "s1", tenantId: "t1:alice" }),
    "remote:s1",
  );
  assert.equal(resolvePromptStashScope({ tenantId: "t1:alice" }), "managed:t1:alice");
  assert.equal(resolvePromptStashScope({}), "local");
});

test("promptStashStorageKey encodes scopes without lossy collisions", () => {
  const left = promptStashStorageKey("managed:acme:a/b");
  const right = promptStashStorageKey("managed:acme:a_b");
  assert.notEqual(left, right);
  assert.match(left, /^aldunis-code:prompt-stash:v1:/);
});

test("getPromptStashBackend keeps managed scopes in isolated memory", () => {
  const local: PromptStashStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const windowLike = { localStorage: local };
  const alice = getPromptStashBackend("managed:t1:alice", windowLike)!;
  const bob = getPromptStashBackend("managed:t1:bob", windowLike)!;
  assert.notEqual(alice, local);
  assert.equal(
    writePromptStash(alice, [createPromptStashEntry("a", { id: "a" })!], "managed:t1:alice"),
    true,
  );
  assert.equal(readPromptStash(bob, "managed:t1:bob").length, 0);
  assert.equal(readPromptStash(alice, "managed:t1:alice").length, 1);
  assert.equal(getPromptStashBackend("local", windowLike), local);
  assert.equal(getPromptStashBackend("remote:s1", windowLike), local);
});

test("readPromptStash migrates unscoped legacy key into local scope", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
    },
    removeItem(key: string) {
      memory.delete(key);
    },
  };
  const entry = createPromptStashEntry("legacy", { id: "legacy" })!;
  memory.set(PROMPT_STASH_STORAGE_KEY, serializePromptStashState([entry]));
  assert.deepEqual(readPromptStash(storage, "local"), [entry]);
  assert.equal(memory.has(promptStashStorageKey("local")), true);
  assert.equal(memory.has(PROMPT_STASH_STORAGE_KEY), false);
});

test("remote and tenant scopes stay isolated; remote keys clear on logout", () => {
  const memory = new Map<string, string>();
  const keys: string[] = [];
  const storage = {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
      if (!keys.includes(key)) keys.push(key);
    },
    removeItem(key: string) {
      memory.delete(key);
      const index = keys.indexOf(key);
      if (index >= 0) keys.splice(index, 1);
    },
    get length() {
      return keys.length;
    },
    key(index: number) {
      return keys[index] ?? null;
    },
  } as PromptStashStorage & { length: number; key: (index: number) => string | null };

  const remoteEntry = createPromptStashEntry("remote draft", { id: "r" })!;
  const managedEntry = createPromptStashEntry("managed draft", { id: "t" })!;
  assert.equal(writePromptStash(storage, [remoteEntry], "remote:abc"), true);
  assert.equal(writePromptStash(storage, [managedEntry], "managed:acme:alice"), true);
  assert.deepEqual(readPromptStash(storage, "remote:abc"), [remoteEntry]);
  assert.deepEqual(readPromptStash(storage, "managed:acme:alice"), [managedEntry]);
  assert.deepEqual(readPromptStash(storage, "managed:acme:bob"), []);
  assert.deepEqual(readPromptStash(storage, "local"), []);

  clearRemotePromptStashes(storage);
  assert.deepEqual(readPromptStash(storage, "remote:abc"), []);
  assert.deepEqual(readPromptStash(storage, "managed:acme:alice"), [managedEntry]);
});

test("readRemoteSessionIdForStash ignores expired sessions", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem() {},
    removeItem() {},
  };
  memory.set(
    "aldunis-code.remote-session.v1",
    JSON.stringify({
      sessionId: "sess-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(readRemoteSessionIdForStash(storage), "sess-1");
  memory.set(
    "aldunis-code.remote-session.v1",
    JSON.stringify({
      sessionId: "sess-old",
      expiresAt: "2000-01-01T00:00:00.000Z",
    }),
  );
  assert.equal(readRemoteSessionIdForStash(storage), null);
});

test("stashPromptRejectionReason explains empty and oversized drafts", () => {
  assert.equal(stashPromptRejectionReason("   "), "Nothing to stash.");
  assert.match(
    stashPromptRejectionReason("x".repeat(MAX_STASH_PROMPT_CHARS + 1)) ?? "",
    /too large to stash/,
  );
  assert.equal(stashPromptRejectionReason("ok"), null);
});

test("getPromptStashStorage fails soft when localStorage access throws", () => {
  assert.equal(getPromptStashStorage(null), null);
  const throwingScope = {};
  Object.defineProperty(throwingScope, "localStorage", {
    get() {
      throw new Error("SecurityError");
    },
  });
  assert.equal(getPromptStashStorage(throwingScope as { localStorage?: PromptStashStorage }), null);
  const memory = new Map<string, string>();
  const storage: PromptStashStorage = {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
    },
    removeItem(key: string) {
      memory.delete(key);
    },
  };
  assert.equal(getPromptStashStorage({ localStorage: storage }), storage);
});

test("matchesPromptStashShortcut only accepts plain Mod+S", () => {
  assert.equal(
    matchesPromptStashShortcut({
      key: "s",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
    true,
  );
  assert.equal(
    matchesPromptStashShortcut({
      key: "S",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    }),
    true,
  );
  assert.equal(
    matchesPromptStashShortcut({
      key: "s",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }),
    false,
  );
  assert.equal(
    matchesPromptStashShortcut({
      key: "s",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
    }),
    false,
  );
  assert.equal(
    matchesPromptStashShortcut({
      key: "s",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: true,
    }),
    false,
  );
});
