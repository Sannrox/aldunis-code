# Desktop distribution

This document fixes the desktop support and release boundary before public
distribution. It is an implementation constraint, not a promise that unsigned
artifacts are safe to distribute.

## Supported systems

| Platform | Minimum | Package | Trust requirement |
| --- | --- | --- | --- |
| macOS | 13 (Ventura), Intel and Apple silicon | signed `.dmg` | Developer ID signing, hardened runtime, notarization, and stapling |
| Windows | Windows 10 22H2, x64 | signed NSIS installer | organization-backed Authenticode signing |
| Linux | Ubuntu 22.04 LTS or equivalent, x64 | AppImage and `.deb` | checksums and signed release provenance |

Wayland is supported through Electron where available; X11 remains the
compatibility path. ARM Linux and Windows on ARM are not initially supported.

## Runtime boundary and lifecycle

Electron's main process starts the existing HTTP host on an operating-system
assigned loopback port and does not create the renderer until the host reports
that it is listening. The renderer loads only that loopback origin. It runs
with context isolation and the Chromium sandbox enabled, with Node integration
disabled. Its preload exposes only the directory picker, shared-browser
controls, and typed desktop-update actions; it does not expose Node or a
general command bridge.

The application takes a single-instance lock. A second launch or an
`aldunis-code://` deep link focuses the existing window; deep links do not
carry repository paths, commands, credentials, or provider input. Closing the
last window begins graceful shutdown and closes the local host before the
process exits. A startup failure exits visibly rather than opening a renderer
against a missing backend.

## Local data

| Data | macOS | Windows | Linux | Retention |
| --- | --- | --- | --- | --- |
| Event history | `~/Library/Application Support/Aldunis Code/state` | `%APPDATA%\\Aldunis Code\\state` | `$XDG_CONFIG_HOME/Aldunis Code/state` | Until user deletion or configured retention |
| Logs | `~/Library/Logs/Aldunis Code` | `%APPDATA%\\Aldunis Code\\logs` | `$XDG_CONFIG_HOME/Aldunis Code/logs` | 14 days, capped at 50 MiB |
| Chromium cache | `~/Library/Caches/Aldunis Code` | `%LOCALAPPDATA%\\Aldunis Code\\Cache` | `$XDG_CONFIG_HOME/Aldunis Code/Cache` | Disposable; cleared by application-data reset |
| Provider credentials | Provider-owned credential store | Provider-owned credential store | Provider-owned credential store | Never copied or persisted by Aldunis Code |

The packaged main process sets the event-history directory explicitly before
constructing the local store. Repository contents, diffs, prompts, and provider
outputs must not be written to application logs. Uninstallers do not silently
delete event history; an in-product delete/reset action is required.

## Signing, provenance, and updates

Release automation must build stable packages on each platform's native, pinned
runner from a protected tag. Opt-in preview packages use the same native jobs
from the selected `main` commit. Signing keys live only in the CI platform's
protected secret or hardware-backed signing service and are unavailable to
pull-request builds.
Every artifact receives a SHA-256 checksum and a signed SLSA provenance
attestation tied to the source commit and workflow identity. macOS artifacts
must pass `codesign`, Gatekeeper assessment, notarization, and stapling;
Windows artifacts must pass signature verification on a clean VM.

The repository-side evidence producer is
`.github/workflows/desktop-release-evidence.yml`. Stable runs happen only for a
`v*` tag and fail unless the tag exactly equals `v` plus the `package.json`
version. Scheduled or manually dispatched runs select `main`, derive a version
such as `0.1.0-nightly.20260804.123`, and create a GitHub prerelease tagged
`preview-v0.1.0-nightly.20260804.123` after every native artifact job succeeds.
The macOS app keeps that prerelease identity in its package metadata while the
workflow supplies the numeric base version for Apple's bundle version fields.
Rerunning the same workflow repairs an existing preview release by replacing
its assets, so a transient upload failure remains recoverable.
That GitHub prerelease is a manually downloaded transport projection only: it
does not publish update metadata, create a Tenkai channel record, or promote a
Tenkai release. Stable outputs remain inputs to the Tenkai-owned release
record:

| Job | Protected environment | Evidence |
| --- | --- | --- |
| macOS Intel and Apple silicon | `desktop-macos-signing` | signed and notarized DMG and update ZIP, SHA-256 checksums, `codesign`, Gatekeeper, and stapling results, GitHub artifact attestation |
| Windows x64 | `desktop-windows-signing` | signed NSIS installer, SHA-256 checksum, Authenticode result and signer subject, GitHub artifact attestation |
| Linux x64 | none | AppImage and Debian package, SHA-256 checksums, native file inspection, GitHub artifact attestations |

Preview packages use the same signing, notarization, checksum, and attestation
checks as stable packages. A missing protected signing environment therefore
fails the preview workflow rather than producing a weaker public artifact.

Repository administrators must configure tag protection and require reviewers
on both signing environments. The workflow expects these environment secrets:

- `desktop-macos-signing`: `MACOS_CSC_LINK`,
  `MACOS_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`.
- `desktop-windows-signing`: `WINDOWS_CSC_LINK` and
  `WINDOWS_CSC_KEY_PASSWORD`.

Never add those values to repository variables, pull-request workflows,
artifacts, logs, or documentation. A release operator links the successful
workflow run, checksums, attestations, and lifecycle test record to the Tenkai
release candidate. Tenkai remains authoritative for promotion, environments,
rollback, and recovery.

There are two channels: `stable` and opt-in `preview`; nightly is the preview
cadence, not a third release authority. Stable packages publish the
electron-builder `latest*.yml` manifests and blockmaps alongside the packaged
artifacts. The packaged client has a fixed GitHub feed, rejects automatic
downgrades, waits before its first background check, and never downloads or
installs without an explicit operator action. macOS and Windows packages and
Linux AppImages can update in place; Debian packages remain manual-update
because their package-manager lifecycle is outside the app. Preview releases
remain manual-download artifacts until a separate preview-channel decision and
clean-machine upgrade evidence exist.

The updater is disabled for development builds, missing update manifests, and
Linux packages that are not running from an AppImage. A restart first closes
the local host and shared-browser sessions through the normal desktop shutdown
path, then invokes Electron's signed-package installer. The renderer receives
only update state and the four explicit actions: check, download, install, and
subscribe to state changes.

Preview uses the same `com.aldunis.code` application identity and local-data
root as stable. Installing preview is therefore an explicit opt-in replacement
of the installed build, not a side-by-side installation or an automatic
channel switch. Manual channel switching and downgrade instructions remain a
separate packaging decision until clean-machine upgrade, rollback, and data
migration tests exist.

Rollback means publishing a newly signed higher version containing the last
known-good code. Previously issued artifacts and update metadata remain
immutable. If a signing key or release workflow is compromised:

1. Disable update publication and revoke the affected certificate or key.
2. Preserve workflow, artifact, and transparency-log evidence.
3. Publish an advisory with affected versions and manual removal guidance.
4. Rotate signing and update-metadata keys through reviewed recovery access.
5. Rebuild from a verified commit on clean runners and publish a higher version.

The repository can now produce signed native build evidence for stable tags and
opt-in nightly previews, but stable public promotion remains fail-closed until
a credentialed tag run succeeds and its install, upgrade, rollback, and
clean-uninstall evidence is attached to the Tenkai release candidate. Local
non-release packages remain dogfooding artifacts, not public releases.
