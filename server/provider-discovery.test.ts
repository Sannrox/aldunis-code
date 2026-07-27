import assert from "node:assert/strict";
import test from "node:test";
import { declarativeAdapterReadiness } from "./provider-discovery.ts";

test("declarativeAdapterReadiness reports disabled, missing CLI, missing env, and ready", () => {
  assert.deepEqual(
    declarativeAdapterReadiness({
      name: "Kiro",
      enabled: false,
      executableFound: true,
      executableNames: ["kiro-cli"],
      missingRequiredEnv: [],
    }),
    { authenticated: false, detail: "Kiro is disabled in Provider adapters." },
  );
  assert.deepEqual(
    declarativeAdapterReadiness({
      name: "Kiro",
      enabled: true,
      executableFound: false,
      executableNames: ["kiro-cli"],
      missingRequiredEnv: [],
    }),
    { authenticated: false, detail: "Install kiro-cli on PATH for Kiro." },
  );
  assert.deepEqual(
    declarativeAdapterReadiness({
      name: "Grok Build",
      enabled: true,
      executableFound: true,
      executableNames: ["grok"],
      missingRequiredEnv: ["XAI_API_KEY"],
    }),
    { authenticated: false, detail: "Set required env for Grok Build: XAI_API_KEY." },
  );
  assert.deepEqual(
    declarativeAdapterReadiness({
      name: "OpenCode",
      enabled: true,
      executableFound: true,
      executableNames: ["opencode"],
      missingRequiredEnv: [],
    }),
    { authenticated: true, detail: null },
  );
});
