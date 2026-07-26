import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { ClaudeProfile, ProfileProbeKind } from "../../types";
import { Button, CloseButton, ModalSurface } from "../../components/ui";

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
  const [binaryPath, setBinaryPath] = useState("claude");
  const [homePath, setHomePath] = useState("");
  const [environment, setEnvironment] = useState("");
  const [sensitiveEnvironment, setSensitiveEnvironment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (profile: ClaudeProfile | null) => {
    setSelectedId(profile?.id ?? null);
    setName(profile?.name ?? "");
    setBinaryPath(profile?.binaryPath ?? "claude");
    setHomePath(profile?.homePath ?? "");
    setEnvironment(profile?.environment.filter((item) => !item.sensitive).map((item) => `${item.name}=${item.value ?? ""}`).join("\n") ?? "");
    setSensitiveEnvironment(profile?.environment.filter((item) => item.sensitive).map((item) => `${item.name}=`).join("\n") ?? "");
    setError(null);
  };
  const openedOnce = useRef(false);
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
        profiles.find((profile) => profile.id === "default:claude-code") ??
        profiles[0] ??
        null;
      edit(preferred);
      return;
    }
    // If the selected profile disappears while open, fall back cleanly.
    if (selectedId && !profiles.some((profile) => profile.id === selectedId)) {
      edit(profiles[0] ?? null);
    }
  }, [open, profiles, selectedId]);
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
      if (!response.ok) throw new Error(result.error ?? "Claude profiles could not be updated.");
      await onChanged();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claude profiles could not be updated.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await request("/api/provider/profiles/save", {
      ...(selected ? { id: selected.id } : {}),
      name,
      binaryPath,
      homePath,
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
  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      dismissible={!busy}
      className="profile-dialog"
      ariaLabelledBy="profile-dialog-title"
    >
        <header>
          <div><p className="eyebrow">Local provider settings</p><h2 id="profile-dialog-title">Claude profiles</h2></div>
          <CloseButton onClick={onClose} label="Close profile settings" />
        </header>
        <div className="profile-dialog-body">
          <nav aria-label="Claude profiles">
            {profiles.map((profile) => {
              const title = `${profile.name}${profile.id === "default:claude-code" ? " · default" : ""}`;
              const detail = profile.homePath || "Default Claude home";
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
                    {profile.id === "default:claude-code" ? " · default" : ""}
                  </strong>
                  <small>{detail}</small>
                </button>
              );
            })}
            <button
              type="button"
              className={!selectedId ? "active add-profile" : "add-profile"}
              onClick={() => edit(null)}
              aria-label="New profile"
              aria-current={!selectedId ? "true" : undefined}
            >
              + New profile
            </button>
          </nav>
          <form onSubmit={save}>
            <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
            <div className="profile-fields">
              <label>Binary path<input value={binaryPath} onChange={(event) => setBinaryPath(event.target.value)} placeholder="claude" /></label>
              <label>Claude config path<input value={homePath} onChange={(event) => setHomePath(event.target.value)} placeholder="~/.claude-personal" /></label>
            </div>
            <label>Environment variables<textarea value={environment} onChange={(event) => setEnvironment(event.target.value)} placeholder={"ANTHROPIC_BASE_URL=https://…"} /></label>
            <label>Sensitive environment values<textarea value={sensitiveEnvironment} onChange={(event) => setSensitiveEnvironment(event.target.value)} placeholder={"ANTHROPIC_AUTH_TOKEN=write-only value"} /></label>
            <p className="secret-note">Sensitive values are write-only. Existing values appear empty and remain stored unless their line is removed.</p>
            {selected && (
              <div className="probe-grid">
                {(["availability", "version", "authentication", "models"] as ProfileProbeKind[]).map((kind) => (
                  <button type="button" onClick={() => void refresh(selected, kind)} disabled={busy} key={kind}>
                    <span className={`probe-state ${selected.probes[kind].state}`} />
                    <strong>{kind}</strong>
                    <small>{selected.probes[kind].detail ?? "Not checked"}</small>
                  </button>
                ))}
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


