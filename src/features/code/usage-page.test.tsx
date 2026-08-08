import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsagePage } from "./usage-page";

test("usage page exposes local scope and range controls before data loads", () => {
  const html = renderToStaticMarkup(<UsagePage onBack={() => undefined} />);

  assert.match(html, /Local provider telemetry/);
  assert.match(html, />Usage</);
  assert.match(html, /7 days/);
  assert.match(html, /30 days/);
  assert.match(html, /90 days/);
  assert.match(html, /only provider turns started from Aldunis Code on this host/);
  assert.match(html, /Reading local usage receipts/);
});
