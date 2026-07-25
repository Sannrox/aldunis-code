import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Card, type CardVariant } from "./card";

const variants: CardVariant[] = ["default", "elevated", "muted", "warning", "danger"];

for (const variant of variants) {
  test(`Card variant=${variant}`, () => {
    const html = renderToStaticMarkup(createElement(Card, { variant }, "body"));
    assert.match(html, new RegExp(`ui-card--${variant}`));
  });
}
