import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_RUN_SETTINGS_STORAGE_KEY,
  defaultComposerRunSettings,
  getComposerRunSettingsStorage,
  isComposerRunSettingsProviderId,
  parseComposerRunSettings,
  readComposerRunSettings,
  resolveNewConversationRunSettings,
  serializeComposerRunSettings,
  writeComposerRunSettings,
  type ComposerRunSettingsStorage,
} from "./composer-run-settings";
import { DEFAULT_NEW_CONVERSATION_PROVIDER } from "./provider-readiness";

function memoryStorage(
  seed: Record<string, string> = {},
): ComposerRunSettingsStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem(key) {
      return key in data ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

test("isComposerRunSettingsProviderId accepts builtins and adapter ids", () => {
  assert.equal(isComposerRunSettingsProviderId("codex-cli"), true);
  assert.equal(isComposerRunSettingsProviderId("claude-code"), true);
  assert.equal(isComposerRunSettingsProviderId("shikigami"), true);
  assert.equal(isComposerRunSettingsProviderId("adapter:dev.xai.grok-build@1.0.0"), true);
  assert.equal(isComposerRunSettingsProviderId("adapter:@1.0.0"), false);
  assert.equal(isComposerRunSettingsProviderId("adapter:pkg"), false);
  assert.equal(isComposerRunSettingsProviderId("unknown"), false);
});

test("parseComposerRunSettings rejects corrupt or incomplete payloads", () => {
  assert.equal(parseComposerRunSettings(null), null);
  assert.equal(parseComposerRunSettings("{not-json"), null);
  assert.equal(parseComposerRunSettings(JSON.stringify({ version: 2 })), null);
  assert.equal(
    parseComposerRunSettings(
      JSON.stringify({
        version: 1,
        provider: "not-a-provider",
        model: "gpt-5",
        reasoningEffort: "medium",
        mode: "ask",
        workspaceMode: "aldunis-managed",
      }),
    ),
    null,
  );
});

test("read/write round-trip preserves last-used run settings", () => {
  const storage = memoryStorage();
  const settings = defaultComposerRunSettings({
    provider: "adapter:dev.xai.grok-build@1.0.0",
    model: "grok-4.5",
    reasoningEffort: "high",
    mode: "build",
    workspaceMode: "provider-native",
    profileId: "  ",
  });
  assert.equal(writeComposerRunSettings(storage, settings), true);
  assert.equal(typeof storage.getItem(COMPOSER_RUN_SETTINGS_STORAGE_KEY), "string");
  assert.deepEqual(readComposerRunSettings(storage), {
    version: 1,
    provider: "adapter:dev.xai.grok-build@1.0.0",
    model: "grok-4.5",
    reasoningEffort: "high",
    mode: "build",
    workspaceMode: "provider-native",
  });
});

test("resolveNewConversationRunSettings prefers stored then handoff provider", () => {
  const stored = defaultComposerRunSettings({
    provider: "claude-code",
    model: "claude-sonnet-5",
    mode: "plan",
    reasoningEffort: "low",
    workspaceMode: "shared",
    profileId: "default:claude-code",
  });
  assert.deepEqual(resolveNewConversationRunSettings({ stored }), stored);
  assert.deepEqual(
    resolveNewConversationRunSettings({
      stored,
      initialProvider: "codex-cli",
    }),
    defaultComposerRunSettings({
      provider: "codex-cli",
      mode: "plan",
      workspaceMode: "aldunis-managed",
      model: "default",
      reasoningEffort: "medium",
    }),
  );
  assert.deepEqual(
    resolveNewConversationRunSettings({
      stored,
      initialProvider: "claude-code",
    }),
    stored,
  );
  assert.equal(
    resolveNewConversationRunSettings({ stored: null }).provider,
    DEFAULT_NEW_CONVERSATION_PROVIDER,
  );
  assert.deepEqual(
    resolveNewConversationRunSettings({
      stored,
      managedMode: true,
      managedModel: "hosted-model",
    }),
    defaultComposerRunSettings({
      provider: "shikigami",
      model: "hosted-model",
      mode: "build",
      workspaceMode: "shared",
      reasoningEffort: "medium",
    }),
  );
});

test("getComposerRunSettingsStorage fails soft when localStorage access throws", () => {
  const throwingScope = {};
  Object.defineProperty(throwingScope, "localStorage", {
    get() {
      throw new Error("blocked");
    },
  });
  assert.equal(
    getComposerRunSettingsStorage(throwingScope as { localStorage?: ComposerRunSettingsStorage }),
    null,
  );
  const storage = memoryStorage();
  assert.equal(getComposerRunSettingsStorage({ localStorage: storage }), storage);
});

test("serializeComposerRunSettings omits empty profile ids", () => {
  const raw = serializeComposerRunSettings(
    defaultComposerRunSettings({ profileId: "default:claude-code" }),
  );
  assert.match(raw, /"profileId":"default:claude-code"/);
  const without = serializeComposerRunSettings(defaultComposerRunSettings({ profileId: "  " }));
  assert.equal(without.includes("profileId"), false);
});
