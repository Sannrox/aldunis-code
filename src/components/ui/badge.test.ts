import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Badge, type BadgeVariant } from "./badge";

const variants: BadgeVariant[] = ["default", "amber", "indigo", "destructive", "muted"];

for (const variant of variants) {
  test(`Badge variant=${variant}`, () => {
    const html = renderToStaticMarkup(createElement(Badge, { variant }, variant));
    assert.match(html, new RegExp(`ui-badge--${variant}`));
  });
}
