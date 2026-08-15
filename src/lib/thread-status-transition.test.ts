import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRefreshAfterRestoredTurn } from "./thread-status-transition";

test("refreshes for every restored transition into or out of attention", () => {
  for (const status of ["waiting_for_approval", "waiting_for_user", "failed"] as const) {
    assert.equal(
      shouldRefreshAfterRestoredTurn(
        { turnId: "turn-1", status: "running" },
        { turnId: "turn-1", status },
      ),
      true,
    );
    assert.equal(
      shouldRefreshAfterRestoredTurn(
        { turnId: "turn-1", status },
        { turnId: "turn-1", status: "completed" },
      ),
      true,
    );
  }
});

test("refreshes when a restored active turn reaches a non-blocking terminal state", () => {
  for (const status of ["completed", "interrupted", "cancelled"] as const) {
    assert.equal(
      shouldRefreshAfterRestoredTurn(
        { turnId: "turn-1", status: "running" },
        { turnId: "turn-1", status },
      ),
      true,
    );
  }
});

test("refreshes the first recovered attention status and a later turn id", () => {
  assert.equal(
    shouldRefreshAfterRestoredTurn(null, { turnId: "turn-1", status: "waiting_for_approval" }),
    true,
  );
  assert.equal(
    shouldRefreshAfterRestoredTurn(null, { turnId: "turn-1", status: "waiting_for_user" }),
    true,
  );
  assert.equal(shouldRefreshAfterRestoredTurn(null, { turnId: "turn-1", status: "failed" }), true);
  assert.equal(
    shouldRefreshAfterRestoredTurn(
      { turnId: "turn-1", status: "completed" },
      { turnId: "turn-2", status: "waiting_for_approval" },
    ),
    true,
  );
  assert.equal(
    shouldRefreshAfterRestoredTurn(
      { turnId: "turn-1", status: "running" },
      { turnId: "turn-2", status: "completed" },
    ),
    true,
  );
});

test("does not refresh equivalent sidebar status, including first idle", () => {
  assert.equal(shouldRefreshAfterRestoredTurn(null, { turnId: "turn-1", status: "idle" }), false);
  assert.equal(
    shouldRefreshAfterRestoredTurn(
      { turnId: "turn-1", status: "active" },
      { turnId: "turn-1", status: "running" },
    ),
    false,
  );
  assert.equal(
    shouldRefreshAfterRestoredTurn(
      { turnId: "turn-1", status: "completed" },
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
