import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DesktopUpdateBanner,
  DesktopUpdateSettings,
} from "./desktop-update";

const available = {
  channel: "stable" as const,
  currentVersion: "0.1.0",
  phase: "available" as const,
  availableVersion: "0.2.0",
};

test("desktop update banner exposes an explicit download action", () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateBanner
      snapshot={available}
      onCheck={() => undefined}
      onDownload={() => undefined}
      onInstall={() => undefined}
    />,
  );

  assert.match(html, /Version 0\.2\.0 available/);
  assert.match(html, />Download<\/button>/);
  assert.match(html, /Dismiss desktop update notification/);
});

test("desktop update settings keeps unsupported builds explanatory and quiet", () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateSettings
      snapshot={{
        channel: "stable",
        currentVersion: "0.1.0",
        phase: "disabled",
        disabledReason: "linux-package",
      }}
      onCheck={() => undefined}
      onDownload={() => undefined}
      onInstall={() => undefined}
    />,
  );

  assert.match(html, /Debian packages are updated through the package manager/);
  assert.doesNotMatch(html, /Check for updates/);
});

test("desktop update settings offers restart only after download", () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateSettings
      snapshot={{ ...available, phase: "downloaded" }}
      onCheck={() => undefined}
      onDownload={() => undefined}
      onInstall={() => undefined}
    />,
  );

  assert.match(html, /Version 0\.2\.0 ready to install/);
  assert.match(html, /Restart to update/);
  assert.doesNotMatch(html, /Download update/);
});

test("desktop update settings identifies the nightly channel", () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateSettings
      snapshot={{ ...available, channel: "nightly" }}
      onCheck={() => undefined}
      onDownload={() => undefined}
      onInstall={() => undefined}
    />,
  );

  assert.match(html, /Nightly channel/);
  assert.match(html, /signed nightly builds/);
});
