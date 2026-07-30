import assert from "node:assert/strict";
import test from "node:test";
import { previewActionError } from "./preview-panel";

test("preview transport failures provide recovery guidance", () => {
  assert.equal(
    previewActionError(new TypeError("Failed to fetch"), "Preview could not be prepared."),
    "Preview service is unavailable. The action was not confirmed; retry when the local host is ready.",
  );
  assert.equal(
    previewActionError(new Error("Preview origin is invalid."), "Preview could not be prepared."),
    "Preview origin is invalid.",
  );
  assert.equal(
    previewActionError(null, "Preview could not be prepared."),
    "Preview could not be prepared.",
  );
});
