import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { InstalledProviderAdapter, ProviderAdapterManifest } from "../../types";
import { Button } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

export function AdapterSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [adapters, setAdapters] = useState<InstalledProviderAdapter[]>([]);
  const [administrationAvailable, setAdministrationAvailable] = useState(true);
  const [source, setSource] = useState("");
  const [digest, setDigest] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [candidate, setCandidate] = useState<InstalledProviderAdapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (route: string, body: unknown = {}) => {
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Adapter operation failed.");
    return result;
  };
  const load = async () => {
    const result = await request("/api/provider/adapters/list") as unknown as {
      adapters: InstalledProviderAdapter[];
      administrationAvailable: boolean;
    };
    setAdapters(result.adapters);
    setAdministrationAvailable(result.administrationAvailable);
  };
  useEffect(() => {
    if (!open) return;
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Adapters could not be loaded."));
  }, [open]);
  if (!open) return null;

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      const manifest = JSON.parse(manifestText) as unknown;
      const result = await request("/api/provider/adapters/inspect", { source, digest, manifest });
      setCandidate(result as unknown as InstalledProviderAdapter);
    } catch (cause) {
      setCandidate(null);
      setError(cause instanceof Error ? cause.message : "Adapter inspection failed.");
    } finally {
      setBusy(false);
    }
  };
  const act = async (route: string, body: unknown = { approved: true }) => {
    setBusy(true);
    setError(null);
    try {
      await request(route, body);
      setCandidate(null);
      await load();
      window.dispatchEvent(new Event("aldunis:adapters-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Adapter operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const existing = candidate
    ? adapters.find((adapter) => adapter.manifest.id === candidate.manifest.id)
    : undefined;

  return (
    <OverlayDialog title="Declarative provider adapters" onClose={onClose}>
      <div className="adapter-settings">
        <p className="adapter-policy">
          You decide which source and publisher to trust. Aldunis verifies the reviewed digest,
          rejects executable package code, and keeps authority inside its ACP runtime and permission broker.
        </p>
        {!administrationAvailable && (
          <p className="context-error" role="status">Remote clients can inspect adapter readiness but cannot administer host adapters.</p>
        )}
        <section className="adapter-list" aria-label="Installed provider adapters">
          {adapters.length === 0 && <p>No declarative adapters installed.</p>}
          {adapters.map((adapter) => (
            <article key={adapter.manifest.id}>
              <header>
                <div>
                  <strong>{adapter.manifest.presentation.name}</strong>
                  <small>{adapter.manifest.id}@{adapter.manifest.version} · {adapter.enabled ? "enabled" : "disabled"}</small>
                </div>
                <code>{adapter.digest}</code>
              </header>
              <p>{adapter.manifest.presentation.description}</p>
              <footer>
                <button disabled={busy || !administrationAvailable} onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/${adapter.enabled ? "disable" : "enable"}`)}>
                  {adapter.enabled ? "Disable" : "Enable"}
                </button>
                <button disabled={busy || !administrationAvailable} onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/rollback`)}>Rollback</button>
                <Button variant="danger" size="sm" disabled={busy || !administrationAvailable} onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/uninstall`)}>Uninstall</Button>
              </footer>
            </article>
          ))}
        </section>
        {administrationAvailable && (
          <section className="adapter-import" aria-label="Inspect a manifest">
            <h3>Inspect a manifest</h3>
            <div className="adapter-import-fields">
              <label className="adapter-field">
                <span>Source URL</span>
                <input
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setCandidate(null);
                  }}
                  placeholder="file:///… or https://…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="adapter-field">
                <span>Expected SHA-256 digest</span>
                <input
                  value={digest}
                  onChange={(event) => {
                    setDigest(event.target.value);
                    setCandidate(null);
                  }}
                  placeholder="sha256:…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="adapter-field adapter-field-manifest">
                <span>Manifest JSON</span>
                <textarea
                  value={manifestText}
                  onChange={(event) => {
                    setManifestText(event.target.value);
                    setCandidate(null);
                  }}
                  rows={10}
                  spellCheck={false}
                />
              </label>
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy || !source || !digest || !manifestText}
              onClick={() => void inspect()}
            >
              {busy ? "Checking…" : "Inspect compatibility"}
            </Button>
          </section>
        )}
        {candidate && (
          <section className="adapter-review" aria-label="Adapter approval review">
            <h3>{existing ? "Review update" : "Review installation"}</h3>
            <dl>
              <div><dt>Source</dt><dd>{candidate.source}</dd></div>
              <div><dt>Publisher claim</dt><dd>{candidate.manifest.publisher.name} · not endorsed by Aldunis</dd></div>
              <div><dt>Integrity</dt><dd>{candidate.digest}</dd></div>
              <div><dt>Compatibility</dt><dd>Aldunis {candidate.manifest.aldunis.minimumVersion}–{candidate.manifest.aldunis.maximumVersion}; ACP {candidate.manifest.protocol.minimumVersion}</dd></div>
              <div><dt>Executable</dt><dd>{candidate.manifest.executable.names.join(", ")}</dd></div>
              <div><dt>Fixed arguments</dt><dd>{candidate.manifest.executable.arguments.join(" ") || "None"}</dd></div>
              <div><dt>Environment names</dt><dd>{candidate.manifest.environment.map((item) => `${item.name}${item.required ? " (required)" : ""}`).join(", ") || "None"}</dd></div>
              <div><dt>Declared capabilities</dt><dd>{Object.entries(candidate.manifest.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "None"}</dd></div>
              <div><dt>Working directory</dt><dd>Canonical conversation worktree</dd></div>
              <div><dt>Provider process authority</dt><dd>Runs as your local OS user. Aldunis bounds cwd and environment, but does not sandbox native filesystem, process, or network access.</dd></div>
              <div><dt>Declared capabilities</dt><dd>Cannot grant Aldunis tool authority; ACP mutations still require allow-once approval</dd></div>
            </dl>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void act(
                existing ? "/api/provider/adapters/update" : "/api/provider/adapters/install",
                { source, digest, manifest: candidate.manifest, approved: true },
              )}
            >
              Approve and {existing ? "update" : "install"}
            </button>
          </section>
        )}
        {error && <p className="context-error" role="alert">{error}</p>}
      </div>
    </OverlayDialog>
  );
}


