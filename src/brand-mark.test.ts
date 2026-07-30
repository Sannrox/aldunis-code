import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AldunisBrandMark } from "./components/brand-mark";

test("Aldunis brand mark exposes exact light and dark theme variants", () => {
  const html = renderToStaticMarkup(createElement(AldunisBrandMark));

  assert.match(html, /aldunis-mark-light\.png/);
  assert.match(html, /aldunis-mark-dark\.png/);
  assert.match(html, /aria-hidden="true"/);
});
