import assert from "node:assert/strict";
import test from "node:test";
import {
  appendBrowsePathSegment,
  getAddProjectInitialQuery,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isFilesystemBrowseQuery,
} from "./project-paths";

test("filesystem browse queries match T3 path prefixes", () => {
  assert.equal(isFilesystemBrowseQuery("~/Projects"), true);
  assert.equal(isFilesystemBrowseQuery("/Users/me"), true);
  assert.equal(isFilesystemBrowseQuery("./src"), true);
  assert.equal(isFilesystemBrowseQuery("notes"), false);
  assert.equal(isFilesystemBrowseQuery("aldunis"), false);
  assert.equal(getAddProjectInitialQuery(), "~/");
});

test("browse path helpers split directories and leaves", () => {
  assert.equal(hasTrailingPathSeparator("~/Projects/"), true);
  assert.equal(getBrowseDirectoryPath("~/Projects/foo"), "~/Projects/");
  assert.equal(getBrowseLeafPathSegment("~/Projects/foo"), "foo");
  assert.equal(getBrowseDirectoryPath("~/Projects/"), "~/Projects/");
  assert.equal(getBrowseLeafPathSegment("~/Projects/"), "");
  assert.equal(appendBrowsePathSegment("~/Projects/", "aldunis-code"), "~/Projects/aldunis-code/");
  assert.equal(getBrowseParentPath("~/Projects/aldunis-code/"), "~/Projects/");
  assert.equal(getBrowseParentPath("~/"), null);
  assert.equal(inferProjectTitleFromPath("/Users/me/Projects/aldunis-code"), "aldunis-code");
});
