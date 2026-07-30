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

The repository-side evidence producer is
`.github/workflows/desktop-release-evidence.yml`. It runs only for a `v*` tag,
fails unless the tag exactly equals `v` plus the `package.json` version, and
does not create a GitHub release or publish update metadata. Its outputs are
inputs to the Tenkai-owned release record:

| Job | Protected environment | Evidence |
| --- | --- | --- |
| macOS Intel and Apple silicon | `desktop-macos-signing` | signed and notarized DMG, SHA-256 checksum, `codesign`, Gatekeeper, and stapling results, GitHub artifact attestation |
| Windows x64 | `desktop-windows-signing` | signed NSIS installer, SHA-256 checksum, Authenticode result and signer subject, GitHub artifact attestation |
| Linux x64 | none | AppImage and Debian package, SHA-256 checksums, native file inspection, GitHub artifact attestations |

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

The repository can now produce signed native build evidence, but public
promotion remains fail-closed until a credentialed tag run succeeds and its
install, upgrade, rollback, and clean-uninstall evidence is attached to the
Tenkai release candidate. Local non-release packages remain dogfooding
artifacts, not public releases.
