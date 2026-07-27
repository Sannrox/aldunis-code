import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { ClaudeProfile, ProfileProbeKind } from "../../types";
import { Button, CloseButton, ModalSurface } from "../../components/ui";
import { providerDisplayName } from "../../lib/provider-readiness";

function isDefaultProfileId(id: string): boolean {
  return id.startsWith("default:");
}

export function parseEnvironment(
  input: string,
  sensitive: boolean,
  existing: ClaudeProfile["environment"],
): ClaudeProfile["environment"] {
  return input.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    const name = (separator === -1 ? line : line.slice(0, separator)).trim();
    const value = separator === -1 ? "" : line.slice(separator + 1);
    const previous = existing.find((variable) => variable.name === name && variable.sensitive === sensitive);
    return sensitive
      ? { name, sensitive: true, value, valueSet: previous?.valueSet === true }
      : { name, sensitive: false, value };
  });
}

const NEW_PROFILE_PROVIDERS = [
  { id: "claude-code", label: "Claude Code", binary: "claude" },
  { id: "codex-cli", label: "Codex CLI", binary: "codex" },
  { id: "shikigami", label: "Shikigami", binary: "shikigami" },
] as const;

function profileProviderLabel(provider: string): string {
  if (provider === "claude-code" || provider === "codex-cli" || provider === "shikigami") {
    return providerDisplayName(provider, undefined);
  }
  if (provider.startsWith("adapter:")) {
    const packageId = provider.slice("adapter:".length).split("@")[0] || provider;
    return packageId;
  }
  return provider;
}

function profileDetail(profile: ClaudeProfile): string {
  const providerLabel = profileProviderLabel(profile.provider);
  if (profile.provider === "claude-code") {
    return profile.homePath ? `${providerLabel} · ${profile.homePath}` : `${providerLabel} · default home`;
  }
  if (profile.binaryPath) return `${providerLabel} · ${profile.binaryPath}`;
  return `${providerLabel} · empty default`;
}

export function ProfileSettingsDialog({
  open,
  profiles,
  onClose,
  onChanged,
}: {
  open: boolean;
  profiles: ClaudeProfile[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("claude-code");
  const [binaryPath, setBinaryPath] = useState("claude");
  const [homePath, setHomePath] = useState("");
  const [environment, setEnvironment] = useState("");
  const [sensitiveEnvironment, setSensitiveEnvironment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (profile: ClaudeProfile | null) => {
    setSelectedId(profile?.id ?? null);
    setName(profile?.name ?? "");
    setProvider(profile?.provider ?? "claude-code");
    setBinaryPath(profile?.binaryPath ?? "claude");
    setHomePath(profile?.homePath ?? "");
    setEnvironment(profile?.environment.filter((item) => !item.sensitive).map((item) => `${item.name}=${item.value ?? ""}`).join("\n") ?? "");
    setSensitiveEnvironment(profile?.environment.filter((item) => item.sensitive).map((item) => `${item.name}=`).join("\n") ?? "");
    setError(null);
  };
  const openedOnce = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) {
      openedOnce.current = false;
      return;
    }
    // On open: select default/first profile so the form is not blank "New profile".
    // Wait until profiles have loaded — marking init complete while profiles is
    // still [] permanently stuck the dialog on empty New profile.
    // Do not re-run this when the user later chooses "+ New profile" (selectedId null).
    if (!openedOnce.current) {
      if (profiles.length === 0) return;
      openedOnce.current = true;
      const preferred =
        profiles.find((profile) => profile.id === "default:claude-code")
        ?? profiles.find((profile) => profile.provider === "claude-code")
        ?? profiles[0]
        ?? null;
      edit(preferred);
      return;
    }
    // If the selected profile disappears while open, fall back cleanly.
    if (selectedId && !profiles.some((profile) => profile.id === selectedId)) {
      edit(profiles[0] ?? null);
    }
  }, [open, profiles, selectedId]);
  useEffect(() => {
    if (!open) return;
    // ModalSurface may focus Close first; reclaim the primary form field.
    const focusName = () => nameInputRef.current?.focus();
    focusName();
    const frame = window.requestAnimationFrame(focusName);
    const timer = window.setTimeout(focusName, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open, selectedId]);
  if (!open) return null;
  const request = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Provider profiles could not be updated.");
      await onChanged();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider profiles could not be updated.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await request("/api/provider/profiles/save", {
      ...(selected ? { id: selected.id } : {}),
      provider: selected?.provider ?? provider,
      name,
      binaryPath,
      homePath: (selected?.provider ?? provider) === "claude-code" ? homePath : "",
      environment: [
        ...parseEnvironment(environment, false, selected?.environment ?? []),
        ...parseEnvironment(sensitiveEnvironment, true, selected?.environment ?? []),
      ],
    }) as ClaudeProfile | null;
    if (saved?.id) edit(saved);
  };
  const refresh = async (profile: ClaudeProfile, kind: ProfileProbeKind) => {
    await request("/api/provider/profiles/refresh", { id: profile.id, kind });
  };
  const isClaude = (selected?.provider ?? provider) === "claude-code";
  const isDefault = selected ? isDefaultProfileId(selected.id) : false;
  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      dismissible={!busy}
      className="profile-dialog"
      ariaLabelledBy="profile-dialog-title"
    >
        <header>
          <div><p className="eyebrow">Local provider settings</p><h2 id="profile-dialog-title">Provider profiles</h2></div>
          <CloseButton onClick={onClose} label="Close profile settings" />
        </header>
        <div className="profile-dialog-body">
          <nav aria-label="Provider profiles">
            {profiles.map((profile) => {
              const title = `${profile.name}${isDefaultProfileId(profile.id) ? " · default" : ""}`;
              const detail = profileDetail(profile);
              return (
                <button
                  type="button"
                  className={selectedId === profile.id ? "active" : ""}
                  onClick={() => edit(profile)}
                  key={profile.id}
                  aria-label={`${title}: ${detail}`}
                  aria-current={selectedId === profile.id ? "true" : undefined}
                >
                  <strong>
                    {profile.name}
                    {isDefaultProfileId(profile.id) ? " · default" : ""}
                  </strong>
                  <small>{detail}</small>
                </button>
              );
            })}
            <button
              type="button"
              className={!selectedId ? "active add-profile" : "add-profile"}
              onClick={() => {
                edit(null);
                setProvider("claude-code");
                setBinaryPath("claude");
                setName("");
              }}
              aria-label="New profile"
              aria-current={!selectedId ? "true" : undefined}
            >
              + New profile
            </button>
          </nav>
          <form onSubmit={save}>
            {!selected && (
              <label htmlFor="profile-provider">Provider
                <select
                  id="profile-provider"
                  name="profile-provider"
                  value={provider}
                  onChange={(event) => {
                    const next = event.target.value;
                    setProvider(next);
                    const match = NEW_PROFILE_PROVIDERS.find((item) => item.id === next);
                    if (match) setBinaryPath(match.binary);
                  }}
                >
                  {NEW_PROFILE_PROVIDERS.map((item) => (
                    <option value={item.id} key={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
            )}
            {selected && (
              <p className="secret-note">
                Provider: <strong>{profileProviderLabel(selected.provider)}</strong>
                {isDefault ? " · system default (re-seeded if deleted)" : ""}
              </p>
            )}
            <label htmlFor="profile-display-name">Display name
              <input
                ref={nameInputRef}
                id="profile-display-name"
                name="profile-display-name"
                data-dialog-initial-focus
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <div className="profile-fields">
              <label htmlFor="profile-binary-path">Binary path
                <input
                  id="profile-binary-path"
                  name="profile-binary-path"
                  value={binaryPath}
                  onChange={(event) => setBinaryPath(event.target.value)}
                  placeholder={isClaude ? "claude" : "binary on PATH"}
                />
              </label>
              {isClaude && (
                <label htmlFor="profile-home-path">Claude config path
                  <input
                    id="profile-home-path"
                    name="profile-home-path"
                    value={homePath}
                    onChange={(event) => setHomePath(event.target.value)}
                    placeholder="~/.claude-personal"
                  />
                </label>
              )}
            </div>
            <label htmlFor="profile-environment">Environment variables
              <textarea
                id="profile-environment"
                name="profile-environment"
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
                placeholder={"KEY=value"}
              />
            </label>
            <label htmlFor="profile-sensitive-environment">Sensitive environment values
              <textarea
                id="profile-sensitive-environment"
                name="profile-sensitive-environment"
                value={sensitiveEnvironment}
                onChange={(event) => setSensitiveEnvironment(event.target.value)}
                placeholder={"SECRET=write-only value"}
              />
            </label>
            <p className="secret-note">Sensitive values are write-only. Existing values appear empty and remain stored unless their line is removed. Empty defaults are normal until you configure them.</p>
            {selected && (
              <div className="probe-grid" aria-label="Profile health probes">
                {(["availability", "version", "authentication", "models"] as ProfileProbeKind[]).map((kind) => {
                  const detail = selected.probes[kind].detail ?? "Not checked";
                  return (
                    <button
                      type="button"
                      onClick={() => void refresh(selected, kind)}
                      disabled={busy}
                      key={kind}
                      aria-label={`Check ${kind}: ${detail}`}
                    >
                      <span className={`probe-state ${selected.probes[kind].state}`} aria-hidden="true" />
                      <strong>{kind}</strong>
                      <small>{detail}</small>
                    </button>
                  );
                })}
              </div>
            )}
            {error && <p className="repository-error" role="alert">{error}</p>}
            <footer>
              {selected && <Button type="button" variant="danger" size="sm" onClick={async () => {
                if (await request("/api/provider/profiles/delete", { id: selected.id })) edit(null);
              }} disabled={busy}>Delete profile</Button>}
              <span />
              <button type="button" onClick={onClose}>Cancel</button>
              <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
                {busy ? "Saving…" : "Save profile"}
              </Button>
            </footer>
          </form>
        </div>
    </ModalSurface>
  );
}
