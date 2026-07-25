import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Separator } from "./separator";

test("Separator horizontal default", () => {
  const html = renderToStaticMarkup(createElement(Separator));
  assert.match(html, /ui-separator--horizontal/);
  assert.match(html, /role="separator"/);
});

test("Separator vertical", () => {
  const html = renderToStaticMarkup(createElement(Separator, { orientation: "vertical" }));
  assert.match(html, /ui-separator--vertical/);
  assert.match(html, /aria-orientation="vertical"/);
});
