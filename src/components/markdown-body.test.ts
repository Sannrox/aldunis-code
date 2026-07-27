import assert from "node:assert/strict";
import test from "node:test";
import { isNavigableMarkdownHref } from "./markdown-body";

test("isNavigableMarkdownHref allows absolute web and mail links only", () => {
  assert.equal(isNavigableMarkdownHref("https://rustup.rs/"), true);
  assert.equal(isNavigableMarkdownHref("http://example.com/a"), true);
  assert.equal(isNavigableMarkdownHref("mailto:ops@example.com"), true);
  assert.equal(isNavigableMarkdownHref("docs/settings.md"), false);
  assert.equal(isNavigableMarkdownHref("./local-run.toml"), false);
  assert.equal(isNavigableMarkdownHref("/absolute/path"), false);
  assert.equal(isNavigableMarkdownHref("#section"), false);
  assert.equal(isNavigableMarkdownHref("javascript:alert(1)"), false);
  assert.equal(isNavigableMarkdownHref(""), false);
  assert.equal(isNavigableMarkdownHref(undefined), false);
});
