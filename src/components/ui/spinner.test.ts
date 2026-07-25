import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Spinner } from "./spinner";

test("Spinner default", () => {
  const html = renderToStaticMarkup(createElement(Spinner));
  assert.match(html, /ui-spinner ui-spinner--md/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Working"/);
});

test("Spinner sm", () => {
  const html = renderToStaticMarkup(createElement(Spinner, { size: "sm", label: "Loading" }));
  assert.match(html, /ui-spinner--sm/);
  assert.match(html, /aria-label="Loading"/);
});
