import assert from "node:assert/strict";
import test from "node:test";
import { selectTestPlan } from "./run-affected-tests.ts";

test("runs unit tests for runtime changes", () => {
  assert.deepEqual(selectTestPlan(["server/permission.ts"]), {
    requiredTiers: ["unit"],
    reason: "Application, test, build, or dependency files changed.",
  });
});

test("runs unit tests for tooling and dependency changes", () => {
  assert.deepEqual(selectTestPlan(["package-lock.json"]), {
    requiredTiers: ["unit"],
    reason: "Application, test, build, or dependency files changed.",
  });
});

test("skips tests for documentation-only changes", () => {
  assert.deepEqual(selectTestPlan(["docs/getting-started.md"]), {
    requiredTiers: [],
    reason: "Only documentation or non-runtime files changed.",
  });
});
