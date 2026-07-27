import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_ENDPOINT_ENV, resolveProductAvailability } from "./products.ts";

test("only Code is available when no plane endpoints are configured", () => {
  assert.deepEqual(resolveProductAvailability({}), {
    code: true,
    sekai: false,
    chisei: false,
    tenkai: false,
  });
});

test("planes become available only when their endpoint env is non-empty", () => {
  assert.deepEqual(
    resolveProductAvailability({
      [PRODUCT_ENDPOINT_ENV.sekai]: "  ",
      [PRODUCT_ENDPOINT_ENV.chisei]: "http://127.0.0.1:50051",
      [PRODUCT_ENDPOINT_ENV.tenkai]: "https://tenkai.example",
    }),
    {
      code: true,
      sekai: false,
      chisei: true,
      tenkai: true,
    },
  );
});
