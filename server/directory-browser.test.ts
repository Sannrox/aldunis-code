import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DirectoryBrowser } from "./directory-browser.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aldunis-directory-browser-"));
  await Promise.all([
    mkdir(join(root, "alpha")),
    mkdir(join(root, "bravo")),
    mkdir(join(root, ".hidden")),
  ]);
  return root;
}

test("directory browsing returns bounded directory metadata and hides dot directories by default", async () => {
  const root = await fixture();
  try {
    const browser = new DirectoryBrowser({ roots: [root] });
    const listing = await browser.browse();
    assert.equal(listing.path, await realpath(root));
    assert.equal(listing.parent, null);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["alpha", "bravo"]);
    assert.equal(listing.entries.every((entry) => Object.keys(entry).sort().join(",") === "hidden,name,path"), true);

    const withHidden = await browser.browse({ includeHidden: true });
    assert.deepEqual(withHidden.entries.map((entry) => entry.name), [".hidden", "alpha", "bravo"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory browsing rejects escapes, files, missing paths, symlinks, and excessive depth", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "aldunis-directory-outside-"));
  try {
    await writeFile(join(root, "file.txt"), "not a directory");
    await symlink(join(root, "alpha"), join(root, "linked"));
    const deep = join(root, "alpha", "one", "two");
    await mkdir(deep, { recursive: true });
    const browser = new DirectoryBrowser({ roots: [root], limits: { maxDepth: 2 } });

    await assert.rejects(() => browser.browse({ path: outside }), /permitted local roots/);
    await assert.rejects(() => browser.browse({ path: join(root, "file.txt") }), /not a directory/);
    await assert.rejects(() => browser.browse({ path: join(root, "missing") }), /no longer exists/);
    await assert.rejects(() => browser.browse({ path: join(root, "linked") }), /Symlinked directories/);
    await assert.rejects(() => browser.browse({ path: deep }), /limited to 2 levels/);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("directory browsing enforces entry, latency, cancellation, and concurrency limits", async () => {
  const root = await fixture();
  try {
    const limited = new DirectoryBrowser({ roots: [root], limits: { maxEntries: 1 } });
    const listing = await limited.browse();
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.truncated, true);

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      () => limited.browse({ signal: cancelled.signal }),
      /cancelled/,
    );

    const timedOut = new DirectoryBrowser({ roots: [root], limits: { timeoutMs: -1 } });
    await assert.rejects(() => timedOut.browse(), /took too long/);

    const saturated = new DirectoryBrowser({ roots: [root], limits: { maxConcurrent: 0 } });
    await assert.rejects(() => saturated.browse(), /Too many directory requests/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
