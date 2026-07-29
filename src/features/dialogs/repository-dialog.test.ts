import assert from "node:assert/strict";
import test from "node:test";
import {
  getProjectPickerInputActiveIndex,
  getProjectPickerPreferredPathIndex,
  getProjectPickerSubmitLabel,
} from "./repository-dialog";

test("exact typed paths prefer the open-path result", () => {
  assert.equal(
    getProjectPickerInputActiveIndex("/Users/me/Projects/aldunis-code"),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(getProjectPickerInputActiveIndex("~/Projects/aldunis-code"), Number.MAX_SAFE_INTEGER);
});

test("directory browsing and project filtering keep the first result active", () => {
  assert.equal(getProjectPickerInputActiveIndex("~/Projects/"), 0);
  assert.equal(getProjectPickerInputActiveIndex("aldunis"), 0);
});

test("typed paths keep the exact open target selected as async rows arrive", () => {
  const path = "/Users/me/Projects/aldunis-code";
  assert.equal(
    getProjectPickerPreferredPathIndex([
      { kind: "parent", path: "/Users/me/Projects/" },
      { kind: "open-path", path },
    ], path),
    1,
  );
  assert.equal(
    getProjectPickerPreferredPathIndex([
      { kind: "parent", path: "/Users/me/Projects/" },
      { kind: "directory", path },
      { kind: "open-path", path },
    ], path),
    2,
  );
});

test("typed paths prefer an exact saved project", () => {
  const path = "/Users/me/Projects/aldunis-code";
  assert.equal(
    getProjectPickerPreferredPathIndex([
      { kind: "project", root: path },
      { kind: "parent", path: "/Users/me/Projects/" },
      { kind: "directory", path },
    ], path),
    0,
  );
});

test("the primary action describes the selected result", () => {
  assert.equal(getProjectPickerSubmitLabel("parent", false), "Go to parent");
  assert.equal(getProjectPickerSubmitLabel("directory", false), "Browse folder");
  assert.equal(getProjectPickerSubmitLabel("project", false), "Open project");
  assert.equal(getProjectPickerSubmitLabel("open-path", false), "Open project");
  assert.equal(getProjectPickerSubmitLabel(undefined, true), "Opening…");
});
