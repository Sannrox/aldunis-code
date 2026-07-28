import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRefreshAfterRestoredTurn } from "./thread-status-transition";

test("refreshes when a restored active turn reaches a terminal state", () => {
  for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
    assert.equal(
      shouldRefreshAfterRestoredTurn(
        { turnId: "turn-1", status: "running" },
        { turnId: "turn-1", status },
      ),
      true,
    );
  }
});

test("does not refresh initial, active, or different-turn observations", () => {
  assert.equal(
    shouldRefreshAfterRestoredTurn(null, { turnId: "turn-1", status: "completed" }),
    false,
  );
  assert.equal(
    shouldRefreshAfterRestoredTurn(
      { turnId: "turn-1", status: "running" },
      { turnId: "turn-1", status: "waiting_for_approval" },
    ),
    false,
  );
  assert.equal(
    shouldRefreshAfterRestoredTurn(
      { turnId: "turn-1", status: "running" },
      { turnId: "turn-2", status: "completed" },
    ),
    false,
  );
  assert.equal(
    shouldRefreshAfterRestoredTurn(
      { turnId: "turn-1", status: "completed" },
      { turnId: "turn-1", status: "completed" },
    ),
    false,
  );
});
