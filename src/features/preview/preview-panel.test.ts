import assert from "node:assert/strict";
import test from "node:test";
import { PreviewPanel } from "./preview-panel";

test("preview panel remains importable through its presentation interface", () => {
  assert.equal(typeof PreviewPanel, "function");
});
