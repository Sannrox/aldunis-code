import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_MANAGEMENT_ACTION_COPY } from "./command-palette";

test("command palette exposes one generic provider management action", () => {
  assert.deepEqual(PROVIDER_MANAGEMENT_ACTION_COPY, {
    label: "Provider management",
    detail: "Profiles, adapter package trust, and readiness diagnostics",
  });
});
