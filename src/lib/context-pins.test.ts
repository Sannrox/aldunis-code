import assert from "node:assert/strict";
import test from "node:test";
import { isRepositoryRelativeContextPinPath } from "./context-pins";

test("context pin paths accept repository-relative files and folders", () => {
  assert.equal(isRepositoryRelativeContextPinPath("."), true);
  assert.equal(isRepositoryRelativeContextPinPath("src/main.ts"), true);
  assert.equal(isRepositoryRelativeContextPinPath("docs\\architecture.md"), true);
});

test("context pin paths reject absolute and worktree-escaping inputs", () => {
  assert.equal(isRepositoryRelativeContextPinPath("../package.json"), false);
  assert.equal(isRepositoryRelativeContextPinPath("src/../../package.json"), false);
  assert.equal(isRepositoryRelativeContextPinPath("/tmp/package.json"), false);
  assert.equal(isRepositoryRelativeContextPinPath("C:/tmp/package.json"), false);
  assert.equal(isRepositoryRelativeContextPinPath(""), false);
});
