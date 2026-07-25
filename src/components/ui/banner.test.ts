import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Banner, type BannerVariant } from "./banner";

const variants: BannerVariant[] = ["default", "warning", "danger", "info"];

for (const variant of variants) {
  test(`Banner variant=${variant}`, () => {
    const html = renderToStaticMarkup(createElement(Banner, { variant }, "msg"));
    assert.match(html, new RegExp(`ui-banner--${variant}`));
  });
}
