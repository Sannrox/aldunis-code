import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_MAX_HEIGHT,
  resetComposerFieldSizingSupportForTests,
  supportsComposerFieldSizing,
  syncComposerHeight,
  type ComposerHeightTarget,
} from "./composer-height";

function target(scrollHeight: number, height = "45px"): ComposerHeightTarget {
  return { scrollHeight, style: { height } };
}

test("syncComposerHeight grows with content up to the desktop composer cap", () => {
  resetComposerFieldSizingSupportForTests();
  // Force the JS polyfill path in unit tests (Node has no CSS.supports).
  assert.equal(
    supportsComposerFieldSizing(() => false),
    false,
  );

  const short = target(92);
  syncComposerHeight(short);
  assert.equal(short.style.height, "92px");

  const long = target(4_381);
  syncComposerHeight(long);
  assert.equal(long.style.height, `${COMPOSER_MAX_HEIGHT}px`);
});

test("syncComposerHeight resets height before measuring so cleared drafts shrink", () => {
  resetComposerFieldSizingSupportForTests();
  assert.equal(
    supportsComposerFieldSizing(() => false),
    false,
  );

  const composer = target(44, "160px");
  const assignments: string[] = [];
  Object.defineProperty(composer.style, "height", {
    get: () => assignments.at(-1) ?? "160px",
    set: (value: string) => {
      assignments.push(value);
    },
  });

  syncComposerHeight(composer);
  assert.deepEqual(assignments, ["0px", "44px"]);
});

test("syncComposerHeight no-ops when field-sizing is available", () => {
  resetComposerFieldSizingSupportForTests();
  assert.equal(
    supportsComposerFieldSizing(() => true),
    true,
  );

  const composer = target(92, "45px");
  syncComposerHeight(composer);
  assert.equal(composer.style.height, "45px");
});
