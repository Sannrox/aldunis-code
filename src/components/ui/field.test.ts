import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Field } from "./field";
import { Input } from "./input";
import { Textarea } from "./textarea";

test("Field wraps label and control", () => {
  const html = renderToStaticMarkup(
    createElement(
      Field,
      { label: "Name", htmlFor: "name", hint: "Required" },
      createElement(Input, { id: "name" }),
    ),
  );
  assert.match(html, /ui-field--default/);
  assert.match(html, /ui-field__label/);
  assert.match(html, /ui-input--md/);
  assert.match(html, /ui-field__hint/);
});

test("Field error takes precedence over hint", () => {
  const html = renderToStaticMarkup(
    createElement(
      Field,
      { label: "Path", error: "Invalid", hint: "ignored" },
      createElement(Textarea, { size: "sm" }),
    ),
  );
  assert.match(html, /ui-field__error/);
  assert.match(html, /Invalid/);
  assert.ok(!html.includes("ui-field__hint"));
  assert.match(html, /ui-textarea--sm/);
});

test("Input and Textarea size classes", () => {
  assert.match(
    renderToStaticMarkup(createElement(Input, { size: "sm" })),
    /ui-input--sm/,
  );
  assert.match(
    renderToStaticMarkup(createElement(Textarea)),
    /ui-textarea--md/,
  );
});
