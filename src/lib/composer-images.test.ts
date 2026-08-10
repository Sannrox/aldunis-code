import assert from "node:assert/strict";
import test from "node:test";
import {
  collectComposerImageFiles,
  isSupportedComposerImage,
  mediaTypeForComposerImage,
  relativePathInsideWorktree,
  MAX_COMPOSER_IMAGE_BYTES,
} from "./composer-images";

function fakeFile(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

test("mediaTypeForComposerImage accepts MIME and extension fallbacks", () => {
  assert.equal(mediaTypeForComposerImage(fakeFile("shot.PNG", "", 12)), "image/png");
  assert.equal(mediaTypeForComposerImage(fakeFile("shot", "image/webp", 12)), "image/webp");
  assert.equal(mediaTypeForComposerImage(fakeFile("notes.txt", "text/plain", 12)), null);
});

test("isSupportedComposerImage enforces type and size bounds", () => {
  assert.equal(isSupportedComposerImage(fakeFile("a.png", "image/png", 1)), true);
  assert.equal(isSupportedComposerImage(fakeFile("a.png", "image/png", 0)), false);
  assert.equal(
    isSupportedComposerImage(fakeFile("a.png", "image/png", MAX_COMPOSER_IMAGE_BYTES + 1)),
    false,
  );
  assert.equal(isSupportedComposerImage(fakeFile("a.pdf", "application/pdf", 12)), false);
});

test("collectComposerImageFiles separates accepted images from rejects", () => {
  const result = collectComposerImageFiles([
    fakeFile("a.png", "image/png", 10),
    fakeFile("b.txt", "text/plain", 10),
    fakeFile("c.jpg", "image/jpeg", 20),
  ]);
  assert.equal(result.images.length, 2);
  assert.equal(result.rejected, 1);
});

test("relativePathInsideWorktree only accepts in-tree absolute paths", () => {
  assert.equal(relativePathInsideWorktree("/repo", "/repo/docs/shot.png"), "docs/shot.png");
  assert.equal(relativePathInsideWorktree("/repo", "/repo"), null);
  assert.equal(relativePathInsideWorktree("/repo", "/other/shot.png"), null);
  assert.equal(relativePathInsideWorktree("/repo", "/repo/../escape.png"), null);
});
