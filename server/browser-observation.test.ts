import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BROWSER_OBSERVATION_BYTES,
  normalizeBrowserObservation,
} from "./browser-observation.ts";

const fixtureImage = Buffer.from("bounded browser fixture", "utf8").toString("base64");

test("browser observations accept bounded inline image bytes and strip location secrets", () => {
  assert.deepEqual(normalizeBrowserObservation({
    provider: "codex-cli",
    observationId: "frame-1",
    data: fixtureImage,
    mimeType: "image/png",
    title: "Checkout",
    url: "https://example.test/checkout?token=private#details",
    toolCallId: "browser-tool-1",
  }), {
    kind: "browser_observation",
    provider: "codex-cli",
    observationId: "frame-1",
    imageData: `data:image/png;base64,${fixtureImage}`,
    mediaType: "image/png",
    title: "Checkout",
    url: "https://example.test/checkout",
    toolCallId: "browser-tool-1",
  });
});

test("browser observations fail closed for paths, unsafe media, malformed base64, and oversized frames", () => {
  assert.equal(normalizeBrowserObservation({
    provider: "codex-cli",
    observationId: "path-frame",
    imageData: "/private/provider/screenshot.png",
    mediaType: "image/png",
  }), null);
  assert.equal(normalizeBrowserObservation({
    provider: "adapter:example.acp-agent@1.0.0",
    observationId: "svg-frame",
    data: fixtureImage,
    mimeType: "image/svg+xml",
  }), null);
  assert.equal(normalizeBrowserObservation({
    provider: "adapter:example.acp-agent@1.0.0",
    observationId: "bad-frame",
    data: "not-base64!",
    mimeType: "image/png",
  }), null);
  assert.equal(normalizeBrowserObservation({
    provider: "adapter:example.acp-agent@1.0.0",
    observationId: "large-frame",
    data: "A".repeat(MAX_BROWSER_OBSERVATION_BYTES),
    mimeType: "image/png",
  }), null);
});
