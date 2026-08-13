import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("web brand marks stay renderer-sized while packaging keeps the source artwork", async () => {
  const [lightWeb, darkWeb, lightPackaging, packageJson] = await Promise.all([
    readFile(new URL("../public/aldunis-mark-light-web.png", import.meta.url)),
    readFile(new URL("../public/aldunis-mark-dark-web.png", import.meta.url)),
    readFile(new URL("../build/aldunis-mark-light.png", import.meta.url)),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(pngDimensions(lightWeb), { width: 128, height: 128 });
  assert.deepEqual(pngDimensions(darkWeb), { width: 128, height: 128 });
  assert.ok(lightWeb.byteLength < 25 * 1024);
  assert.ok(darkWeb.byteLength < 25 * 1024);
  assert.deepEqual(pngDimensions(lightPackaging), { width: 1024, height: 1024 });
  assert.equal(JSON.parse(packageJson).build.icon, "build/aldunis-mark-light.png");
});
