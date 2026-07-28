import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPackageSummary } from "./context-package";

test("context package summary distinguishes included, omitted, and provider-managed entries", () => {
  const html = renderToStaticMarkup(<ContextPackageSummary receipt={{
    pins: [{ path: "src", kind: "folder" }],
    entries: [
      {
        path: "src/main.ts",
        type: "text",
        source: "aldunis_folder",
        bytes: 24,
        truncated: false,
        digest: "a".repeat(64),
        omissionReason: null,
      },
      {
        path: "AGENTS.md",
        type: "instruction",
        source: "provider_managed_instruction",
        bytes: null,
        truncated: false,
        digest: null,
        omissionReason: "provider-managed effectiveness was not reported",
      },
    ],
    totalBytes: 24,
    estimatedTokens: 6,
    digest: "b".repeat(64),
  }} />);
  assert.match(html, /1 files/);
  assert.match(html, /Pinned folder/);
  assert.match(html, /Provider-managed instruction/);
  assert.match(html, /Omitted: provider-managed effectiveness was not reported/);
  assert.match(html, /sha256:aaaaaaaaaaaa/);
});
