import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangedFilesTruncationNotice } from "./changes-panel";

test("changed-file truncation is visible and announced", () => {
  const html = renderToStaticMarkup(<ChangedFilesTruncationNotice count={256} />);
  assert.match(html, /role="status"/);
  assert.match(html, /Showing the first 256 changed files/);
  assert.match(html, /remaining changes/);
});
