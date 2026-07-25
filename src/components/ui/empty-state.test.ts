import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { EmptyState } from "./empty-state";

test("EmptyState default structure", () => {
  const html = renderToStaticMarkup(
    createElement(EmptyState, {
      eyebrow: "New",
      title: "Open a repository",
      description: "Choose a root.",
    }),
  );
  assert.match(html, /ui-empty--default/);
  assert.match(html, /ui-empty__eyebrow/);
  assert.match(html, /ui-empty__title/);
  assert.match(html, /Open a repository/);
});

test("EmptyState panel variant", () => {
  const html = renderToStaticMarkup(
    createElement(EmptyState, { variant: "panel", title: "Missing" }),
  );
  assert.match(html, /ui-empty--panel/);
});
