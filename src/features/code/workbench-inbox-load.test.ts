import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  nextRestoreStateAfterProjectionAccept,
  nextRestoreStateAfterRestoreFailure,
  sidebarInboxEmptyMode,
  workbenchConversationPanesVisible,
} from "./workbench-inbox-load";

test("an accepted projection unlocks Open after restore already failed", () => {
  assert.equal(nextRestoreStateAfterProjectionAccept("failed"), "ready");
  assert.equal(nextRestoreStateAfterProjectionAccept("loading"), "ready");
  assert.equal(nextRestoreStateAfterProjectionAccept("ready"), "ready");
  assert.equal(nextRestoreStateAfterProjectionAccept("idle"), "idle");
  assert.equal(
    workbenchConversationPanesVisible({ restoreState: "ready", hasRepository: true }),
    true,
  );
  assert.equal(
    workbenchConversationPanesVisible({ restoreState: "failed", hasRepository: true }),
    false,
  );
  assert.equal(
    workbenchConversationPanesVisible({ restoreState: "failed", hasRepository: false }),
    true,
  );
});

test("restore failure does not hide panes after sync already accepted a snapshot", () => {
  assert.equal(
    nextRestoreStateAfterRestoreFailure({ current: "ready", projectionAccepted: true }),
    "ready",
  );
  assert.equal(
    nextRestoreStateAfterRestoreFailure({ current: "loading", projectionAccepted: true }),
    "ready",
  );
  assert.equal(
    nextRestoreStateAfterRestoreFailure({ current: "loading", projectionAccepted: false }),
    "failed",
  );
  assert.equal(
    nextRestoreStateAfterRestoreFailure({ current: "failed", projectionAccepted: false }),
    "failed",
  );
});

test("empty inbox chrome distinguishes load failure from a genuine empty list", () => {
  assert.equal(
    sidebarInboxEmptyMode({ restoreState: "loading", hasVisibleConversations: false }),
    "loading",
  );
  assert.equal(
    sidebarInboxEmptyMode({ restoreState: "failed", hasVisibleConversations: false }),
    "failed",
  );
  assert.equal(
    sidebarInboxEmptyMode({ restoreState: "ready", hasVisibleConversations: false }),
    "empty",
  );
  assert.equal(
    sidebarInboxEmptyMode({ restoreState: "failed", hasVisibleConversations: true }),
    null,
  );
});

test("workbench restore applies the same snapshot that unlocks the inbox", () => {
  const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
  assert.match(source, /workbenchProjectionSnapshot\(/);
  assert.match(source, /acceptStateProjection\(snapshot\)/);
  assert.match(source, /nextRestoreStateAfterProjectionAccept/);
  assert.match(source, /nextRestoreStateAfterRestoreFailure/);
  assert.match(source, /workbenchConversationPanesVisible/);
  assert.match(source, /inboxLoadState=\{restoreState\}/);
});
