import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_NEW_CONVERSATION_PROVIDER_ORDER,
  canSwitchNewConversationProvider,
  cycleProviderModel,
  cycleReasoningEffort,
  DEFAULT_NEW_CONVERSATION_PROVIDER,
  parseProviderFailure,
  providerConfigurationVerifiedAfterFailure,
  providerFailureRecovery,
  providerFailureNeedsConfiguration,
  providerTextReportsAuthenticationFailure,
  prettifyModelId,
  providerAvatarInitials,
  providerChipName,
  providerDisplayName,
  providerModelLabel,
  providerModelOptions,
  providerNotReadyMessage,
  providerReasoningEfforts,
  resolveDefaultProviderModel,
} from "./provider-readiness";
import type { ProviderDiscovery } from "../types";

test("new conversations prefer Codex before other built-in providers", () => {
  assert.equal(DEFAULT_NEW_CONVERSATION_PROVIDER, "codex-cli");
  assert.deepEqual(BUILTIN_NEW_CONVERSATION_PROVIDER_ORDER, [
    "codex-cli",
    "claude-code",
    "shikigami",
  ]);
  assert.equal(canSwitchNewConversationProvider("codex-cli", ["claude-code"]), true);
  assert.equal(canSwitchNewConversationProvider("codex-cli", ["codex-cli"]), false);
  assert.equal(
    canSwitchNewConversationProvider("codex-cli", ["codex-cli", "claude-code"]),
    true,
  );
});

test("providerDisplayName and providerChipName cover first-class and adapter ids", () => {
  assert.equal(providerDisplayName("claude-code", undefined), "Claude Code");
  // Composer chip uses short friendly labels, not machine ids.
  assert.equal(providerChipName("claude-code", undefined), "Claude");
  assert.equal(providerChipName("codex-cli", undefined), "Codex");
  assert.equal(providerChipName("shikigami", undefined), "Shikigami");
  // Known adapters keep the product label even when discovery shortens it.
  assert.equal(
    providerDisplayName("adapter:kiro-cli@1.0.0", {
      id: "adapter:kiro-cli@1.0.0",
      installed: true,
      name: "Kiro",
    }),
    "Kiro CLI",
  );
  assert.equal(
    providerDisplayName("adapter:dev.xai.grok-build@1.0.0", {
      id: "adapter:dev.xai.grok-build@1.0.0",
      installed: true,
      name: "Grok Build CLI",
    }),
    "Grok Build",
  );
  // Known package ids prefer the stable list label over discovery names
  // that append "CLI" or shorten the product name.
  assert.equal(
    providerChipName("adapter:kiro-cli@1.0.0", {
      id: "adapter:kiro-cli@1.0.0",
      installed: true,
      name: "Kiro",
    }),
    "Kiro CLI",
  );
  assert.equal(
    providerChipName("adapter:dev.xai.grok-build@1.0.0", {
      id: "adapter:dev.xai.grok-build@1.0.0",
      installed: true,
      name: "Grok Build CLI",
    }),
    "Grok Build",
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
  // T3-style: no synthetic "default" row — only discovered models.
  assert.equal(options[0]?.id, "gpt-5");
  assert.equal(options[0]?.displayName, "GPT-5");
  assert.equal(options[1]?.id, "o3");
  assert.equal(cycleProviderModel("codex-cli", "default", discovery), "o3");
  assert.equal(cycleProviderModel("codex-cli", "gpt-5", discovery), "o3");
  assert.equal(cycleProviderModel("codex-cli", "o3", discovery), "gpt-5");
  assert.equal(providerModelLabel("codex-cli", "gpt-5", discovery), "GPT-5");
  // Unpinned "default" resolves to the discovery isDefault model label.
  assert.equal(providerModelLabel("codex-cli", "default", discovery), "GPT-5");
});

test("resolveDefaultProviderModel prefers discovery isDefault then first real model", () => {
  const discovery: ProviderDiscovery = {
    id: "codex-cli",
    installed: true,
    authenticated: true,
    models: [
      { id: "o3", displayName: "o3", isDefault: false },
      { id: "gpt-5", displayName: "GPT-5", isDefault: true },
    ],
  };
  assert.equal(resolveDefaultProviderModel("codex-cli", discovery), "gpt-5");
  assert.equal(
    resolveDefaultProviderModel("codex-cli", {
      id: "codex-cli",
      installed: true,
      models: [{ id: "o3", displayName: "o3", isDefault: false }],
    }),
    "o3",
  );
  // Claude prefers full T3 slug claude-sonnet-5, not a short "sonnet" alias.
  assert.equal(resolveDefaultProviderModel("claude-code", undefined), "claude-sonnet-5");
});

test("Claude model options use T3-style full slugs and versioned labels", () => {
  assert.equal(cycleProviderModel("claude-code", "default", undefined), "claude-opus-5");
  assert.equal(cycleProviderModel("claude-code", "claude-haiku-4-5", undefined), "claude-sonnet-5");
  assert.deepEqual(
    providerModelOptions("claude-code", undefined).map((entry) => entry.id),
    [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5",
    ],
  );
  assert.deepEqual(
    providerModelOptions("claude-code", undefined).map((entry) => entry.displayName),
    ["Sonnet 5", "Opus 5", "Sonnet 4.6", "Opus 4.6", "Haiku 4.5"],
  );
  assert.equal(providerModelLabel("claude-code", "sonnet", undefined), "Sonnet 5");
  assert.equal(providerModelLabel("claude-code", "default", undefined), "Sonnet 5");
  assert.equal(providerModelLabel("claude-code", "claude-sonnet-5", undefined), "Sonnet 5");
});

test("prettifyModelId humanizes session-restored slugs without discovery", () => {
  assert.equal(prettifyModelId("grok-4.5"), "Grok 4.5");
  assert.equal(prettifyModelId("gpt-5.2-codex"), "GPT 5.2 Codex");
  assert.equal(prettifyModelId("auto"), "Auto");
  assert.equal(prettifyModelId("default"), "default");
  // Without discovery, labels fall back to prettified ids (not the raw slug).
  assert.equal(
    providerModelLabel("adapter:dev.xai.grok-build@1.0.0", "grok-4.5", undefined),
    "Grok 4.5",
  );
  assert.equal(providerModelLabel("adapter:dev.kiro.cli@1.0.0", "auto", undefined), "Auto");
});

test("providerModelLabel prettifies when discovery echoes the machine id", () => {
  const discovery: ProviderDiscovery = {
    id: "codex-cli",
    installed: true,
    models: [
      { id: "gpt-5.2-codex", displayName: "gpt-5.2-codex", isDefault: true },
      { id: "o3", displayName: "o3", isDefault: false },
    ],
  };
  assert.equal(providerModelLabel("codex-cli", "gpt-5.2-codex", discovery), "GPT 5.2 Codex");
  assert.equal(providerModelLabel("codex-cli", "o3", discovery), "o3");
  // Real product labels are kept.
  assert.equal(
    providerModelLabel("codex-cli", "gpt-5.2-codex", {
      ...discovery,
      models: [{ id: "gpt-5.2-codex", displayName: "GPT-5.2 Codex", isDefault: true }],
    }),
    "GPT-5.2 Codex",
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

test("provider failures distinguish configuration recovery from retryable failures", () => {
  assert.equal(
    providerFailureNeedsConfiguration("Failed to authenticate. API Error: 401 OAuth access token has been revoked."),
    true,
  );
  assert.equal(providerFailureNeedsConfiguration("Sign in to Codex CLI (codex login)."), true);
  assert.equal(providerFailureNeedsConfiguration("Not logged in · Please run /login"), true);
  assert.equal(providerFailureNeedsConfiguration("Provider process exited unexpectedly."), false);
  assert.equal(providerFailureNeedsConfiguration("Request timed out."), false);
  assert.equal(providerFailureNeedsConfiguration("API key validation service timed out."), false);
  assert.equal(providerFailureNeedsConfiguration("Request failed while checking credentials."), false);
});

test("assistant text only triggers recovery for explicit authentication errors", () => {
  assert.equal(
    providerTextReportsAuthenticationFailure("Failed to authenticate. API Error: 401 OAuth access token has been revoked."),
    true,
  );
  assert.equal(providerTextReportsAuthenticationFailure("Authentication failed: credentials expired."), true);
  assert.equal(
    providerTextReportsAuthenticationFailure("Connecting…\nAuthentication failed: credentials expired."),
    true,
  );
  assert.equal(providerTextReportsAuthenticationFailure("Not logged in · Please run /login"), true);
  assert.equal(
    providerTextReportsAuthenticationFailure("I checked the API key configuration before the process exited."),
    false,
  );
  assert.equal(providerTextReportsAuthenticationFailure("Request timed out after checking authentication."), false);
});

test("provider failure recovery changes only after configuration is verified", () => {
  assert.deepEqual(providerFailureRecovery("Claude", true, false), {
    message: "Claude needs setup · update provider settings before retrying",
    showSettings: true,
  });
  assert.deepEqual(providerFailureRecovery("Claude", true, true), {
    message: "Claude is ready · retry when you are ready",
    showSettings: false,
  });
  assert.deepEqual(providerFailureRecovery("Claude", false, true), {
    message: "Claude stopped · review the error above before retrying",
    showSettings: false,
  });
});

test("authentication recovery requires a successful probe newer than the failed turn", () => {
  const failureAt = "2026-07-29T12:00:00.000Z";
  assert.equal(providerConfigurationVerifiedAfterFailure(undefined, failureAt), false);
  assert.equal(providerConfigurationVerifiedAfterFailure({
    state: "ready",
    checkedAt: "2026-07-29T11:59:59.000Z",
    detail: "Authentication is ready.",
    authenticated: true,
  }, failureAt), false);
  assert.equal(providerConfigurationVerifiedAfterFailure({
    state: "unavailable",
    checkedAt: "2026-07-29T12:01:00.000Z",
    detail: "Authentication failed.",
    authenticated: false,
  }, failureAt), false);
  assert.equal(providerConfigurationVerifiedAfterFailure({
    state: "ready",
    checkedAt: "2026-07-29T12:01:00.000Z",
    detail: "Authentication is ready.",
    authenticated: true,
  }, failureAt), true);
});
