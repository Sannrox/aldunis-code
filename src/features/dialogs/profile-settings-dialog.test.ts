import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudeProfile } from "../../types";
import { initialProfileForProvider } from "./profile-settings-dialog";

function profile(id: string, provider: string): ClaudeProfile {
  const probe = {
    state: "unknown" as const,
    checkedAt: null,
    detail: null,
  };
  return {
    schemaVersion: 1,
    id,
    name: id,
    provider,
    binaryPath: provider,
    homePath: "",
    configPath: "",
    environment: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    probes: {
      availability: probe,
      version: probe,
      authentication: probe,
      models: probe,
    },
  };
}

const profiles = [
  profile("default:claude-code", "claude-code"),
  profile("default:codex-cli", "codex-cli"),
  profile("default:shikigami", "shikigami"),
  profile("default:adapter:dev.kiro.cli", "adapter:dev.kiro.cli"),
];

test("provider recovery selects the profile owned by the failing provider", () => {
  assert.equal(initialProfileForProvider(profiles, "codex-cli")?.id, "default:codex-cli");
  assert.equal(initialProfileForProvider(profiles, "shikigami")?.id, "default:shikigami");
  assert.equal(
    initialProfileForProvider(profiles, "adapter:dev.kiro.cli@1.0.0")?.id,
    "default:adapter:dev.kiro.cli",
  );
});

test("generic profile entry preserves the Claude-first default", () => {
  assert.equal(initialProfileForProvider(profiles)?.id, "default:claude-code");
});

test("provider recovery fails closed when no matching profile exists", () => {
  assert.equal(initialProfileForProvider(profiles, "adapter:missing.provider@1.0.0"), null);
});
