import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Button, CloseButton, type ButtonSize, type ButtonVariant } from "./button";

const variants: ButtonVariant[] = ["default", "primary", "secondary", "ghost", "danger"];
const sizes: ButtonSize[] = ["xs", "sm", "md", "lg", "icon", "icon-sm"];

test("Button composes default classes", () => {
  const html = renderToStaticMarkup(createElement(Button, null, "Save"));
  assert.match(html, /class="ui-button ui-button--default ui-button--md"/);
  assert.match(html, />Save</);
  assert.match(html, /type="button"/);
});

for (const variant of variants) {
  test(`Button variant=${variant} class`, () => {
    const html = renderToStaticMarkup(
      createElement(Button, { variant, size: "sm" }, variant),
    );
    assert.match(html, new RegExp(`ui-button--${variant}`));
    assert.match(html, /ui-button--sm/);
  });
}

for (const size of sizes) {
  test(`Button size=${size} class`, () => {
    const html = renderToStaticMarkup(
      createElement(Button, { size, variant: "ghost" }, "x"),
    );
    assert.match(html, new RegExp(`ui-button--${size === "icon-sm" ? "icon-sm" : size}`));
  });
}

test("Button merges layout className without rebuilding variant strings at call site", () => {
  const html = renderToStaticMarkup(
    createElement(Button, { variant: "primary", className: "header-slot" }, "Go"),
  );
  assert.match(html, /ui-button--primary/);
  assert.match(html, /header-slot/);
});

test("CloseButton renders accessible dismiss control", () => {
  const html = renderToStaticMarkup(
    createElement(CloseButton, { label: "Close dialog" }),
  );
  assert.match(html, /aria-label="Close dialog"/);
  assert.match(html, /ui-button/);
  assert.match(html, />×</);
});
