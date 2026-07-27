import assert from "node:assert/strict";
import test from "node:test";
import {
  cycleProviderModel,
  cycleReasoningEffort,
  parseProviderFailure,
  providerAvatarInitials,
  providerChipName,
  providerDisplayName,
  providerModelLabel,
  providerModelOptions,
  providerNotReadyMessage,
  providerReasoningEfforts,
} from "./provider-readiness";
import type { ProviderDiscovery } from "../types";

test("providerDisplayName and providerChipName cover first-class and adapter ids", () => {
  assert.equal(providerDisplayName("claude-code", undefined), "Claude Code");
  assert.equal(providerChipName("codex-cli", undefined), "codex-cli");
  assert.equal(providerChipName("shikigami", undefined), "shikigami");
  assert.equal(
    providerDisplayName("adapter:kiro-cli@1.0.0", {
      id: "adapter:kiro-cli@1.0.0",
      installed: true,
      name: "Kiro",
    }),
    "Kiro",
  );
  assert.equal(
    providerChipName("adapter:kiro-cli@1.0.0", {
      id: "adapter:kiro-cli@1.0.0",
      installed: true,
      name: "Kiro",
    }),
    "Kiro",
  );
  // Without discovery, still name known adapters from package id (incl. reverse-DNS).
  assert.equal(
    providerDisplayName("adapter:dev.xai.grok-build@1.0.0", undefined),
    "Grok Build",
  );
  assert.equal(
    providerDisplayName("adapter:kiro-cli@1.0.0", undefined),
    "Kiro CLI",
  );
  assert.equal(
    providerDisplayName("adapter:dev.kiro.cli@1.0.0", undefined),
    "Kiro CLI",
  );
  assert.equal(
    providerChipName("adapter:dev.xai.grok-build@1.0.0", undefined),
    "Grok Build",
  );
  assert.equal(providerAvatarInitials("claude-code", "Claude"), "CC");
  assert.equal(
    providerAvatarInitials("adapter:dev.xai.grok-build@1.0.0", "Grok Build"),
    "GB",
  );
  assert.equal(
    providerAvatarInitials("adapter:kiro-cli@1.0.0", "Kiro CLI"),
    "KR",
  );
  assert.equal(
    providerAvatarInitials("adapter:dev.kiro.cli@1.0.0", "Kiro CLI"),
    "KR",
  );
});

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
  assert.equal(
    providerNotReadyMessage("adapter:dev.xai.grok-build@1.0.0", undefined, {
      hasClaudeProfile: true,
      providerName: "Grok Build",
    }),
    "Install the Grok Build CLI…",
  );
  assert.equal(
    providerNotReadyMessage("adapter:unknown@1.0.0", undefined, {
      hasClaudeProfile: true,
      providerName: "Provider adapter",
    }),
    "Install the provider adapter CLI…",
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

test("Codex reasoning effort cycles advertised options", () => {
  const discovery: ProviderDiscovery = {
    id: "codex-cli",
    installed: true,
    authenticated: true,
    models: [
      {
        id: "gpt-5",
        displayName: "GPT-5",
        isDefault: true,
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ],
  };
  assert.deepEqual(providerReasoningEfforts("codex-cli", "gpt-5", discovery), ["low", "medium", "high"]);
  assert.equal(cycleReasoningEffort("codex-cli", "gpt-5", "medium", discovery), "high");
  assert.equal(cycleReasoningEffort("codex-cli", "gpt-5", "high", discovery), "low");
  assert.deepEqual(providerReasoningEfforts("shikigami", "scripted", undefined), []);
  assert.deepEqual(
    providerReasoningEfforts("codex-cli", "no-effort", {
      id: "codex-cli",
      installed: true,
      authenticated: true,
      models: [{ id: "no-effort", displayName: "No effort", isDefault: false, reasoningEfforts: [] }],
    }),
    [],
  );
});

test("parseProviderFailure splits park summary and resume command", () => {
  const parsed = parseProviderFailure(
    'Shikigami parked: need operator input. Question: continue?. Resume is not wired in Aldunis Code yet; use the CLI: shikigami run --resume bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee --answer "...".',
  );
  assert.equal(parsed.kind, "park");
  assert.match(parsed.summary, /need operator input/);
  assert.equal(parsed.question, "continue?");
  assert.equal(
    parsed.resumeCommand,
    'shikigami run --resume bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee --answer "..."',
  );
  assert.equal(parseProviderFailure("Codex CLI could not start.").kind, "generic");
});
