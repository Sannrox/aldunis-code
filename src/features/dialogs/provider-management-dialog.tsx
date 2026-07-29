import React, { useEffect, useRef, useState } from "react";
import type { ClaudeProfile, ProviderId } from "../../types";
import { CloseButton, ModalSurface } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import { AdapterSettingsDialog } from "./adapter-settings-dialog";
import { ProfileSettingsDialog } from "./profile-settings-dialog";

export const PROVIDER_MANAGEMENT_DESTINATIONS = [
  "profiles",
  "adapters",
  "diagnostics",
] as const;

export type ProviderManagementDestination =
  (typeof PROVIDER_MANAGEMENT_DESTINATIONS)[number];

export function moveProviderManagementFocus(
  current: ProviderManagementDestination,
  direction: "next" | "previous" | "first" | "last",
): ProviderManagementDestination {
  if (direction === "first") return PROVIDER_MANAGEMENT_DESTINATIONS[0];
  if (direction === "last") return PROVIDER_MANAGEMENT_DESTINATIONS.at(-1)!;
  const index = PROVIDER_MANAGEMENT_DESTINATIONS.indexOf(current);
  const delta = direction === "next" ? 1 : -1;
  return PROVIDER_MANAGEMENT_DESTINATIONS[
    (index + delta + PROVIDER_MANAGEMENT_DESTINATIONS.length)
      % PROVIDER_MANAGEMENT_DESTINATIONS.length
  ]!;
}

function probeSummary(profile: ClaudeProfile): {
  state: "ready" | "attention" | "unknown";
  detail: string;
} {
  const probes = Object.entries(profile.probes);
  const failed = probes.find(([, probe]) => probe.state === "unavailable");
  if (failed) return { state: "attention", detail: failed[1].detail ?? `${failed[0]} needs attention` };
  if (profile.probes.availability.state === "ready") {
    return { state: "ready", detail: profile.probes.availability.detail ?? "Provider executable is available" };
  }
  return { state: "unknown", detail: "Run profile checks to confirm readiness" };
}

export function ProviderManagementDialog({
  open,
  profiles,
  initialDestination = "diagnostics",
  initialProvider,
  onClose,
  onProfilesChanged,
}: {
  open: boolean;
  profiles: ClaudeProfile[];
  initialDestination?: ProviderManagementDestination;
  initialProvider?: ProviderId | null;
  onClose: () => void;
  onProfilesChanged: () => Promise<void>;
}) {
  const [destination, setDestination] = useState<ProviderManagementDestination>(
    initialDestination,
  );
  const [targetProvider, setTargetProvider] = useState<ProviderId | null>(
    initialProvider ?? null,
  );
  const [targetRequest, setTargetRequest] = useState(0);
  const tabRefs = useRef<Record<ProviderManagementDestination, HTMLButtonElement | null>>({
    profiles: null,
    adapters: null,
    diagnostics: null,
  });

  useEffect(() => {
    if (open) {
      setDestination(initialDestination);
      setTargetProvider(initialProvider ?? null);
      if (initialDestination === "profiles") {
        setTargetRequest((current) => current + 1);
      }
      if (initialDestination === "profiles") {
        const frame = window.requestAnimationFrame(() => {
          document.getElementById("profile-display-name")?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
      }
    }
  }, [initialDestination, initialProvider, open]);

  const moveFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: ProviderManagementDestination,
  ) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? "next"
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? "previous"
        : event.key === "Home"
          ? "first"
          : event.key === "End"
            ? "last"
            : null;
    if (!direction) return;
    event.preventDefault();
    const next = moveProviderManagementFocus(current, direction);
    setDestination(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      className="provider-management-dialog"
      ariaLabelledBy="provider-management-title"
    >
      <header className="provider-management-header">
        <div>
          <p className="eyebrow">Local provider administration</p>
          <h2 id="provider-management-title">Provider management</h2>
          <p>Configure runtimes, review package trust, and diagnose readiness without merging their authority.</p>
        </div>
        <CloseButton onClick={onClose} label="Close provider management" />
      </header>
      <div className="provider-management-layout">
        <nav role="tablist" aria-label="Provider management destinations">
          {PROVIDER_MANAGEMENT_DESTINATIONS.map((item) => (
            <button
              key={item}
              ref={(node) => { tabRefs.current[item] = node; }}
              type="button"
              role="tab"
              id={`provider-management-tab-${item}`}
              aria-controls={`provider-management-panel-${item}`}
              aria-selected={destination === item}
              tabIndex={destination === item ? 0 : -1}
              className={destination === item ? "active" : ""}
              onClick={() => setDestination(item)}
              onKeyDown={(event) => moveFocus(event, item)}
            >
              <strong>{item === "adapters" ? "Adapter packages" : item[0]!.toUpperCase() + item.slice(1)}</strong>
              <small>
                {item === "profiles" && "Runtime paths, environment, and login guidance"}
                {item === "adapters" && "Digest review, lifecycle, and process trust"}
                {item === "diagnostics" && "Read-only readiness and recovery routing"}
              </small>
            </button>
          ))}
        </nav>
        <section
          id="provider-management-panel-profiles"
          role="tabpanel"
          aria-labelledby="provider-management-tab-profiles"
          className="provider-management-panel"
          hidden={destination !== "profiles"}
        >
          <ProfileSettingsDialog
            embedded
            open={destination === "profiles"}
            profiles={profiles}
            initialProvider={targetProvider}
            targetRequest={targetRequest}
            onClose={onClose}
            onChanged={onProfilesChanged}
          />
        </section>
        <section
          id="provider-management-panel-adapters"
          role="tabpanel"
          aria-labelledby="provider-management-tab-adapters"
          className="provider-management-panel"
          hidden={destination !== "adapters"}
        >
          <AdapterSettingsDialog
            embedded
            open={destination === "adapters"}
            onClose={onClose}
          />
        </section>
        <section
          id="provider-management-panel-diagnostics"
          role="tabpanel"
          aria-labelledby="provider-management-tab-diagnostics"
          className="provider-management-panel"
          hidden={destination !== "diagnostics"}
        >
          {destination === "diagnostics" && (
            <div className="provider-diagnostics">
              <header>
                <p className="eyebrow">Read-only projection</p>
                <h3>Provider readiness</h3>
                <p>Diagnostics never installs a package, changes a profile, or signs in to a provider.</p>
              </header>
              {profiles.length === 0 && <p>No provider profiles are available.</p>}
              <div className="provider-diagnostic-list">
                {profiles.map((profile) => {
                  const summary = probeSummary(profile);
                  const adapterProfile = profile.provider.startsWith("adapter:");
                  return (
                    <article key={profile.id}>
                      <div>
                        <strong>{profile.name}</strong>
                        <small>{providerListLabel(profile.provider)} · {summary.detail}</small>
                      </div>
                      <span className={`provider-diagnostic-state ${summary.state}`}>{summary.state}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setTargetProvider(profile.provider as ProviderId);
                          setTargetRequest((current) => current + 1);
                          setDestination("profiles");
                        }}
                        aria-label={`Open profile settings for ${profile.name}`}
                      >
                        Configure profile
                      </button>
                      {adapterProfile && (
                        <button
                          type="button"
                          onClick={() => setDestination("adapters")}
                          aria-label={`Open package status for ${providerListLabel(profile.provider)}`}
                        >
                          Package status
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
              <p className="provider-credential-note">
                Provider login and OAuth remain provider-owned. Aldunis can show probe results and guidance,
                but it does not own, delete, or recover provider credentials.
              </p>
            </div>
          )}
        </section>
      </div>
    </ModalSurface>
  );
}
