import assert from "node:assert/strict";
import test from "node:test";
import {
  moveProviderManagementFocus,
  PROVIDER_MANAGEMENT_DESTINATIONS,
} from "./provider-management-dialog";

test("provider management exposes explicit authority-preserving destinations", () => {
  assert.deepEqual(
    PROVIDER_MANAGEMENT_DESTINATIONS,
    ["profiles", "adapters", "diagnostics"],
  );
});

test("provider management tab focus wraps and supports boundaries", () => {
  assert.equal(moveProviderManagementFocus("profiles", "previous"), "diagnostics");
  assert.equal(moveProviderManagementFocus("diagnostics", "next"), "profiles");
  assert.equal(moveProviderManagementFocus("adapters", "first"), "profiles");
  assert.equal(moveProviderManagementFocus("profiles", "last"), "diagnostics");
});
