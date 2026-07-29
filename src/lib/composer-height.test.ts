import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_MAX_HEIGHT,
  syncComposerHeight,
  type ComposerHeightTarget,
} from "./composer-height";

function target(scrollHeight: number, height = "45px"): ComposerHeightTarget {
  return { scrollHeight, style: { height } };
}

test("syncComposerHeight grows with content up to the desktop composer cap", () => {
  const short = target(92);
  syncComposerHeight(short);
  assert.equal(short.style.height, "92px");

  const long = target(4_381);
  syncComposerHeight(long);
  assert.equal(long.style.height, `${COMPOSER_MAX_HEIGHT}px`);
});

test("syncComposerHeight resets height before measuring so cleared drafts shrink", () => {
  const composer = target(44, "160px");
  const assignments: string[] = [];
  Object.defineProperty(composer.style, "height", {
    get: () => assignments.at(-1) ?? "160px",
    set: (value: string) => {
      assignments.push(value);
    },
  });

  syncComposerHeight(composer);
  assert.deepEqual(assignments, ["auto", "44px"]);
});
