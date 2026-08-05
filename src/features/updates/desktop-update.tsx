import React, { useEffect, useState } from "react";
import { Button } from "../../components/ui";
import type { DesktopUpdateSnapshot } from "../../../desktop/update-contract";

export interface DesktopUpdateControls {
  snapshot: DesktopUpdateSnapshot | null;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}

function updateVersion(snapshot: DesktopUpdateSnapshot): string {
  return snapshot.availableVersion ? `Version ${snapshot.availableVersion}` : "A new version";
}

function disabledMessage(reason: DesktopUpdateSnapshot["disabledReason"]): string {
  switch (reason) {
    case "development":
      return "Updates become available when running a packaged desktop build.";
    case "linux-package":
      return "Debian packages are updated through the package manager. AppImage builds support in-app updates.";
    case "environment":
      return "Automatic updates are disabled for this installation.";
    case "no-feed":
      return "This build has no configured update feed.";
    default:
      return "Updates are not available for this build.";
  }
}

function bannerTitle(snapshot: DesktopUpdateSnapshot): string {
  if (snapshot.phase === "error") return "Update check failed";
  if (snapshot.phase === "downloaded") return "Update ready";
  if (snapshot.phase === "downloading") return `Downloading ${updateVersion(snapshot)}`;
  if (snapshot.phase === "installing") return "Restarting to install update";
  return `${updateVersion(snapshot)} available`;
}

function bannerDescription(snapshot: DesktopUpdateSnapshot): string | undefined {
  if (snapshot.phase === "error") return snapshot.error;
  if (snapshot.phase === "downloaded") return `${updateVersion(snapshot)} is downloaded and ready to install.`;
  if (snapshot.phase === "downloading") return `Downloading ${updateVersion(snapshot)}.`;
  if (snapshot.phase === "installing") return "Closing Aldunis Code and applying the update.";
  return "Download the update when you are ready.";
}

export function DesktopUpdateBanner({
  snapshot,
  onCheck,
  onDownload,
  onInstall,
}: DesktopUpdateControls) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [snapshot?.phase, snapshot?.availableVersion]);

  if (
    !snapshot
    || dismissed
    || snapshot.phase === "disabled"
    || snapshot.phase === "idle"
    || snapshot.phase === "checking"
  ) return null;

  const isError = snapshot.phase === "error";
  return (
    <section className="desktop-update-banner" aria-labelledby="desktop-update-title">
      <div className="desktop-update-copy">
        <strong id="desktop-update-title">{bannerTitle(snapshot)}</strong>
        {bannerDescription(snapshot) && <span>{bannerDescription(snapshot)}</span>}
        {snapshot.phase === "downloading" && (
          <progress
            className="desktop-update-progress"
            value={snapshot.progress ?? 0}
            max={100}
            aria-label={`Downloading ${updateVersion(snapshot)}`}
          />
        )}
      </div>
      <div className="desktop-update-actions">
        {snapshot.phase === "available" && (
          <Button type="button" variant="primary" size="sm" onClick={onDownload}>Download</Button>
        )}
        {snapshot.phase === "downloaded" && (
          <Button type="button" variant="primary" size="sm" onClick={onInstall}>Restart to update</Button>
        )}
        {isError && (
          <Button type="button" variant="default" size="sm" onClick={onCheck}>Try again</Button>
        )}
        {snapshot.phase !== "installing" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Dismiss desktop update notification"
            onClick={() => setDismissed(true)}
          >
            Dismiss
          </Button>
        )}
      </div>
    </section>
  );
}

export function DesktopUpdateSettings({
  snapshot,
  onCheck,
  onDownload,
  onInstall,
}: DesktopUpdateControls) {
  if (!snapshot) {
    return <p className="preference-note">Desktop update status is unavailable.</p>;
  }
  if (snapshot.phase === "disabled") {
    return <p className="preference-note">{disabledMessage(snapshot.disabledReason)}</p>;
  }

  return (
    <div className="desktop-update-settings">
      <div className="desktop-update-settings-status" role="status" aria-live="polite">
        <strong>
          {snapshot.phase === "error"
            ? "Could not check for updates"
            : snapshot.phase === "downloaded"
              ? `${updateVersion(snapshot)} ready to install`
              : snapshot.phase === "available"
                ? `${updateVersion(snapshot)} available`
                : snapshot.phase === "downloading"
                  ? `Downloading ${updateVersion(snapshot)}`
                  : snapshot.phase === "installing"
                    ? "Restarting to install update"
                    : snapshot.phase === "checking"
                      ? "Checking for updates…"
                      : `Up to date · ${snapshot.currentVersion}`}
        </strong>
        {snapshot.error && <span>{snapshot.error}</span>}
        {snapshot.phase === "downloading" && (
          <progress
            className="desktop-update-progress"
            value={snapshot.progress ?? 0}
            max={100}
            aria-label={`Downloading ${updateVersion(snapshot)}`}
          />
        )}
      </div>
      <div className="desktop-update-settings-actions">
        {(snapshot.phase === "idle" || snapshot.phase === "error") && (
          <Button type="button" variant="primary" onClick={onCheck}>
            Check for updates
          </Button>
        )}
        {snapshot.phase === "available" && (
          <Button type="button" variant="primary" onClick={onDownload}>
            Download update
          </Button>
        )}
        {snapshot.phase === "downloaded" && (
          <Button type="button" variant="primary" onClick={onInstall}>
            Restart to update
          </Button>
        )}
      </div>
    </div>
  );
}
