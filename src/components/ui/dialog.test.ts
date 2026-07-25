import assert from "node:assert/strict";
import { test } from "node:test";
import { handleNestedEscape } from "./dialog";

function keyEvent(key: string) {
  let stopped = false;
  let prevented = false;
  return {
    key,
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {
      prevented = true;
    },
    get stopped() {
      return stopped;
    },
    get prevented() {
      return prevented;
    },
  };
}

test("nested Escape dismisses local draft and stops propagation (fea9931 comment)", () => {
  let dismissed = false;
  const event = keyEvent("Escape");
  const handled = handleNestedEscape(event, () => {
    dismissed = true;
  });
  assert.equal(handled, true);
  assert.equal(dismissed, true);
  assert.equal(event.stopped, true);
  assert.equal(event.prevented, true);
});

test("non-Escape keys are ignored by nested handler", () => {
  let dismissed = false;
  const event = keyEvent("Enter");
  const handled = handleNestedEscape(event, () => {
    dismissed = true;
  });
  assert.equal(handled, false);
  assert.equal(dismissed, false);
  assert.equal(event.stopped, false);
});

test("nested Escape for revision preview only (fea9931 preview)", () => {
  // Same stopPropagation contract as NestedDialogSurface: parent must not see Escape.
  const parents: string[] = [];
  const event = keyEvent("Escape");
  handleNestedEscape(event, () => parents.push("nested-closed"));
  // Parent would only run if propagation continued.
  if (!event.stopped) parents.push("parent-closed");
  assert.deepEqual(parents, ["nested-closed"]);
});
