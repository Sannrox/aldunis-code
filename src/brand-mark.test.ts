import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AldunisBrandMark } from "./components/brand-mark";

test("Aldunis brand mark exposes one decorative theme-selected surface", () => {
  const html = renderToStaticMarkup(createElement(AldunisBrandMark));

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /class="aldunis-brand-mark"/);
  assert.match(html, /aria-hidden="true"/);
});
