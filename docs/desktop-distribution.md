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
disabled and no preload bridge.

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

Release automation must build each platform on its native, pinned runner from a
protected tag. Signing keys live only in the CI platform's protected secret or
hardware-backed signing service and are unavailable to pull-request builds.
Every artifact receives a SHA-256 checksum and a signed SLSA provenance
attestation tied to the source commit and workflow identity. macOS artifacts
must pass `codesign`, Gatekeeper assessment, notarization, and stapling;
Windows artifacts must pass signature verification on a clean VM.

There are two channels: `stable` and opt-in `preview`. Update metadata is
signed independently from package hosting. The client accepts only a valid
signature for its selected channel and never downgrades automatically. Update
checks may be added only after those controls and clean-machine packaging tests
exist; this PR intentionally contains no auto-updater.

Rollback means publishing a newly signed higher version containing the last
known-good code. Previously issued artifacts and update metadata remain
immutable. If a signing key or release workflow is compromised:

1. Disable update publication and revoke the affected certificate or key.
2. Preserve workflow, artifact, and transparency-log evidence.
3. Publish an advisory with affected versions and manual removal guidance.
4. Rotate signing and update-metadata keys through reviewed recovery access.
5. Rebuild from a verified commit on clean runners and publish a higher version.

Public distribution remains blocked until native signed builds, install,
upgrade, rollback, and clean-uninstall evidence are attached to a release PR.
