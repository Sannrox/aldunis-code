import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleProviderModel,
  providerModelLabel,
  providerModelOptions,
  providerNotReadyMessage,
} from "./provider-readiness";
import type { ProviderDiscovery } from "../types";

test("providerNotReadyMessage prefers host detail", () => {
  const discovery: ProviderDiscovery = {
    id: "shikigami",
    installed: true,
    authenticated: false,
    detail: "Unsupported shikigami version. Aldunis Code requires 1.0.2+.",
  };
  assert.equal(
    providerNotReadyMessage("shikigami", discovery, {
      hasClaudeProfile: true,
      providerName: "Shikigami",
    }),
    "Unsupported shikigami version. Aldunis Code requires 1.0.2+.",
  );
});

test("providerNotReadyMessage covers Claude, Codex, Shikigami, and adapters", () => {
  assert.match(
    providerNotReadyMessage("claude-code", { id: "claude-code", installed: true }, {
      hasClaudeProfile: false,
      providerName: "Claude Code",
    }),
    /Claude profile/,
  );
  assert.match(
    providerNotReadyMessage("codex-cli", { id: "codex-cli", installed: false, authenticated: false }, {
      hasClaudeProfile: true,
      providerName: "Codex CLI",
    }),
    /Install Codex CLI/,
  );
  assert.match(
    providerNotReadyMessage("codex-cli", { id: "codex-cli", installed: true, authenticated: false }, {
      hasClaudeProfile: true,
      providerName: "Codex CLI",
    }),
    /Sign in to Codex/,
  );
  assert.match(
    providerNotReadyMessage("shikigami", { id: "shikigami", installed: false, authenticated: false }, {
      hasClaudeProfile: true,
      providerName: "Shikigami",
    }),
    /Install shikigami/,
  );
  assert.match(
    providerNotReadyMessage("adapter:kiro-cli@1.0.0", {
      id: "adapter:kiro-cli@1.0.0",
      installed: true,
      authenticated: false,
      name: "Kiro",
    }, {
      hasClaudeProfile: true,
      providerName: "Kiro",
    }),
    /CLI on PATH/,
  );
});

test("providerModelOptions and cycleProviderModel walk discovered models", () => {
  const discovery: ProviderDiscovery = {
    id: "codex-cli",
    installed: true,
    authenticated: true,
    models: [
      { id: "gpt-5", displayName: "GPT-5", isDefault: true },
      { id: "o3", displayName: "o3", isDefault: false },
    ],
  };
  const options = providerModelOptions("codex-cli", discovery);
  assert.equal(options[0]?.id, "default");
  assert.equal(options[1]?.id, "gpt-5");
  assert.equal(cycleProviderModel("codex-cli", "default", discovery), "gpt-5");
  assert.equal(cycleProviderModel("codex-cli", "gpt-5", discovery), "o3");
  assert.equal(cycleProviderModel("codex-cli", "o3", discovery), "default");
  assert.equal(providerModelLabel("codex-cli", "gpt-5", discovery), "GPT-5");
});

test("Claude model cycle keeps legacy presentation order", () => {
  assert.equal(cycleProviderModel("claude-code", "default", undefined), "sonnet");
  assert.equal(cycleProviderModel("claude-code", "haiku", undefined), "default");
  assert.deepEqual(
    providerModelOptions("claude-code", undefined).map((entry) => entry.id),
    ["default", "sonnet", "opus", "haiku"],
  );
});
