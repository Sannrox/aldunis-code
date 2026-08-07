import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageCopyButton } from "./message-copy-button";

test("message copy button exposes a message-specific accessible label", () => {
  const html = renderToStaticMarkup(
    createElement(MessageCopyButton, {
      text: "Fix the failing test",
      label: "Copy prompt",
    }),
  );

  assert.match(html, /class="[^"]*message-copy-button[^"]*"/);
  assert.match(html, /aria-label="Copy prompt"/);
  assert.match(html, /title="Copy prompt to clipboard"/);
});
