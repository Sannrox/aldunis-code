import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRODUCT_AVAILABILITY,
  isProductAvailable,
  readProductAvailabilityResponse,
  resolveChiseiInspectAction,
} from "./product-availability";

test("default availability only enables Code", () => {
  assert.equal(isProductAvailable("code", DEFAULT_PRODUCT_AVAILABILITY), true);
  assert.equal(isProductAvailable("sekai", DEFAULT_PRODUCT_AVAILABILITY), false);
  assert.equal(isProductAvailable("chisei", DEFAULT_PRODUCT_AVAILABILITY), false);
  assert.equal(isProductAvailable("tenkai", DEFAULT_PRODUCT_AVAILABILITY), false);
});

test("Inspect in Chisei stays on Code when the Chisei plane is disabled", () => {
  assert.equal(resolveChiseiInspectAction(undefined), "explain-unavailable");
  assert.equal(resolveChiseiInspectAction(DEFAULT_PRODUCT_AVAILABILITY), "explain-unavailable");
  assert.equal(
    resolveChiseiInspectAction({
      code: true,
      sekai: false,
      chisei: true,
      tenkai: false,
    }),
    "open-product",
  );
});

test("availability response rejects incomplete payloads and forces Code on", () => {
  assert.equal(readProductAvailabilityResponse({ code: true, sekai: true }), null);
  assert.deepEqual(
    readProductAvailabilityResponse({
      code: false,
      sekai: true,
      chisei: false,
      tenkai: false,
    }),
    {
      code: true,
      sekai: true,
      chisei: false,
      tenkai: false,
    },
  );
});
