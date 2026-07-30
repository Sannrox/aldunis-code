import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import {
  closeServer,
  isSupportedDeepLink,
  listenOnLoopback,
  localApplicationUrl,
  selectedDirectoryPath,
} from "./lifecycle.ts";
import { validateDesktopReleaseTag } from "../scripts/verify-desktop-release-tag.ts";

test("packaged startup waits for a loopback backend on an ephemeral port", async () => {
  const server = createServer((_request, response) => response.end("ready"));
  const url = await listenOnLoopback(server);
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await fetch(url).then((response) => response.text()), "ready");
  } finally {
    await closeServer(server);
  }
  assert.equal(server.listening, false);
});

test("backend readiness rejects non-TCP and unavailable addresses", () => {
  assert.throws(() => localApplicationUrl(null), /did not provide a TCP address/);
  assert.throws(() => localApplicationUrl("/tmp/aldunis.sock"), /did not provide a TCP address/);
});

test("deep links accept only the registered application protocol", () => {
  assert.equal(isSupportedDeepLink("aldunis-code://open"), true);
  assert.equal(isSupportedDeepLink("https://example.com"), false);
  assert.equal(isSupportedDeepLink("not a URL"), false);
});

test("native directory selection returns one path and cancellation returns no authority", () => {
  assert.equal(selectedDirectoryPath({ canceled: false, filePaths: ["/project", "/other"] }), "/project");
  assert.equal(selectedDirectoryPath({ canceled: true, filePaths: ["/project"] }), null);
  assert.equal(selectedDirectoryPath({ canceled: false, filePaths: [] }), null);
});

test("desktop ESM build leaves CommonJS state locking outside the bundle", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: { "build:desktop-main"?: string };
  };
  const command = packageJson.scripts?.["build:desktop-main"];
  const [mainProcessBuild] = command?.split("&&", 1) ?? [];

  assert.match(mainProcessBuild ?? "", /esbuild desktop\/main\.ts/);
  assert.match(mainProcessBuild ?? "", /--format=esm/);
  assert.match(mainProcessBuild ?? "", /--external:proper-lockfile/);
  assert.match(mainProcessBuild ?? "", /--external:@grpc\/grpc-js/);
  assert.match(mainProcessBuild ?? "", /--external:@grpc\/proto-loader/);
});

test("desktop build emits the Shikigami permission hook beside the main bundle", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: { "build:desktop-main"?: string };
  };
  const command = packageJson.scripts?.["build:desktop-main"] ?? "";

  assert.match(command, /esbuild server\/shikigami-permission-hook\.mjs/);
  assert.match(command, /--format=esm/);
  assert.match(command, /--outfile=dist-electron\/shikigami-permission-hook\.mjs/);
});

test("desktop release evidence is bound to the package version", () => {
  assert.doesNotThrow(() => validateDesktopReleaseTag("v0.1.0", "0.1.0"));
  assert.throws(
    () => validateDesktopReleaseTag("v0.1.1", "0.1.0"),
    /must exactly match package version/,
  );
  assert.throws(
    () => validateDesktopReleaseTag("0.1.0", "0.1.0"),
    /must exactly match package version/,
  );
});

test("native packages cannot overwrite the web build output", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    build?: { directories?: { output?: string } };
  };

  assert.equal(packageJson.build?.directories?.output, "release");
});
