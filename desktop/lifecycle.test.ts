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
import { nightlyVersion, previewTag } from "../scripts/preview-version.ts";
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

test("desktop ESM build leaves CommonJS runtime dependencies outside the bundle", async () => {
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
  assert.match(mainProcessBuild ?? "", /--external:@iarna\/toml/);
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

test("desktop build emits the host-owned browser MCP bridge beside the main bundle", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: { "build:desktop-main"?: string };
  };
  const command = packageJson.scripts?.["build:desktop-main"] ?? "";

  assert.match(command, /esbuild server\/browser-mcp\.mjs/);
  assert.match(command, /--format=esm/);
  assert.match(command, /--outfile=dist-electron\/browser-mcp\.mjs/);
});

test("shared browser validates webview attachment parameters before guest creation", async () => {
  const source = await readFile(new URL("./shared-browser.ts", import.meta.url), "utf8");
  assert.match(source, /will-attach-webview/);
  assert.match(source, /about:blank/);
  assert.match(source, /aldunis-browser-\[0-9a-f\]\{32\}/);
  assert.match(source, /deleteProperty\(webPreferences, "preload"\)/);
  assert.match(source, /pendingAgentInputs/);
  assert.doesNotMatch(source, /agentInputUntil/);
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

test("preview versions are generated as dated semver prereleases", () => {
  const version = nightlyVersion("0.1.0", "20260804", 17);
  assert.equal(version, "0.1.0-nightly.20260804.17");
  assert.equal(previewTag(version), "preview-v0.1.0-nightly.20260804.17");
  assert.throws(
    () => nightlyVersion("0.1.0-nightly.20260803.16", "20260804", 17),
    /base package version is invalid/,
  );
  assert.throws(
    () => nightlyVersion("0.1.0", "2026-08-04", 17),
    /UTC build date is invalid/,
  );
});

test("desktop distribution workflow keeps preview publication separate from stable tags", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/desktop-release-evidence.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_tag="preview-v\$\{version\}"/);
  assert.match(workflow, /verify:desktop-release-tag/);
  assert.match(workflow, /npm version --no-git-tag-version/);
  assert.match(workflow, /-c\.mac\.bundleShortVersion="\$\{BASE_VERSION\}"/);
  assert.match(workflow, /-c\.mac\.bundleVersion="\$\{BASE_VERSION\}"/);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /--clobber/);
  assert.match(workflow, /contents: write/);
});

test("native packages cannot overwrite the web build output", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    build?: { directories?: { output?: string } };
  };

  assert.equal(packageJson.build?.directories?.output, "release");
});

test("mac packages explain the microphone permission used by voice input", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    build?: {
      mac?: {
        entitlements?: string;
        entitlementsInherit?: string;
        extendInfo?: { NSMicrophoneUsageDescription?: string };
      };
    };
  };

  assert.match(packageJson.build?.mac?.extendInfo?.NSMicrophoneUsageDescription ?? "", /microphone/i);

  const appEntitlements = await readFile(new URL("../build/entitlements.mac.plist", import.meta.url), "utf8");
  const inheritedEntitlements = await readFile(
    new URL("../build/entitlements.mac.inherit.plist", import.meta.url),
    "utf8",
  );
  assert.equal(packageJson.build?.mac?.entitlements, "build/entitlements.mac.plist");
  assert.equal(packageJson.build?.mac?.entitlementsInherit, "build/entitlements.mac.inherit.plist");
  for (const entitlements of [appEntitlements, inheritedEntitlements]) {
    assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
    assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
    assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  }
  assert.match(appEntitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(inheritedEntitlements, /com\.apple\.security\.device\.audio-input/);
});
