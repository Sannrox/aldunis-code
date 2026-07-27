import React, { useEffect, useRef, useState } from "react";
import type { InstalledProviderAdapter, ReviewedAdapterCatalogEntry } from "../../types";
import { Button } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

export function AdapterSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [adapters, setAdapters] = useState<InstalledProviderAdapter[]>([]);
  const [catalog, setCatalog] = useState<ReviewedAdapterCatalogEntry[]>([]);
  const [administrationAvailable, setAdministrationAvailable] = useState(true);
  const [source, setSource] = useState("");
  const [digest, setDigest] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [candidate, setCandidate] = useState<InstalledProviderAdapter | null>(null);
  const [pendingPackage, setPendingPackage] = useState<{
    source: string;
    digest: string;
    manifest: InstalledProviderAdapter["manifest"];
    mode: "install" | "update" | "reinstall" | "view";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const reviewRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

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
    const [listResult, catalogResult] = await Promise.all([
      request("/api/provider/adapters/list") as Promise<{
        adapters: InstalledProviderAdapter[];
        administrationAvailable: boolean;
      }>,
      request("/api/provider/adapters/catalog") as Promise<{
        adapters: ReviewedAdapterCatalogEntry[];
        administrationAvailable: boolean;
      }>,
    ]);
    setAdapters(listResult.adapters);
    setCatalog(catalogResult.adapters);
    setAdministrationAvailable(listResult.administrationAvailable && catalogResult.administrationAvailable);
  };
  useEffect(() => {
    if (!open) return;
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Adapters could not be loaded."));
  }, [open]);
  // Install review is appended below the catalog — bring it into view so Approve is reachable.
  useEffect(() => {
    if (!candidate || !pendingPackage) return;
    const node = reviewRef.current;
    const body = bodyRef.current;
    if (!node) return;
    // Prefer scrolling the dialog body; fall back to scrollIntoView.
    window.requestAnimationFrame(() => {
      if (body) {
        const top = node.offsetTop - 12;
        body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      } else {
        node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }, [candidate, pendingPackage]);
  if (!open) return null;

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      const manifest = JSON.parse(manifestText) as unknown;
      const result = await request("/api/provider/adapters/inspect", { source, digest, manifest });
      setCandidate(result as unknown as InstalledProviderAdapter);
      setPendingPackage({
        source,
        digest,
        manifest: (result as unknown as InstalledProviderAdapter).manifest,
        mode: adapters.some((adapter) => adapter.manifest.id === (result as InstalledProviderAdapter).manifest.id)
          ? "update"
          : "install",
      });
    } catch (cause) {
      setCandidate(null);
      setPendingPackage(null);
      setError(cause instanceof Error ? cause.message : "Adapter inspection failed.");
    } finally {
      setBusy(false);
    }
  };

  const reviewCatalogEntry = async (entry: ReviewedAdapterCatalogEntry) => {
    if (!administrationAvailable || !entry.package) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await request("/api/provider/adapters/catalog/prepare", { slug: entry.slug }) as {
        candidate: InstalledProviderAdapter;
        entry: ReviewedAdapterCatalogEntry;
      };
      setSource(prepared.entry.package?.source ?? prepared.candidate.source);
      setDigest(prepared.candidate.digest);
      setManifestText(JSON.stringify(prepared.candidate.manifest, null, 2));
      setCandidate(prepared.candidate);
      setPendingPackage({
        source: prepared.entry.package?.source ?? prepared.candidate.source,
        digest: prepared.candidate.digest,
        manifest: prepared.candidate.manifest,
        mode: prepared.entry.action === "update"
          ? "update"
          : prepared.entry.action === "reinstall-same"
          ? "reinstall"
          : prepared.entry.action === "current"
          ? "view"
          : "install",
      });
      setAdvancedOpen(false);
    } catch (cause) {
      setCandidate(null);
      setPendingPackage(null);
      setError(cause instanceof Error ? cause.message : "Reviewed adapter could not be prepared.");
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
      setPendingPackage(null);
      await load();
      window.dispatchEvent(new Event("aldunis:adapters-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Adapter operation failed.");
    } finally {
      setBusy(false);
    }
  };

  const approvePending = async () => {
    if (!pendingPackage) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        source: pendingPackage.source,
        digest: pendingPackage.digest,
        manifest: pendingPackage.manifest,
        approved: true,
      };
      if (pendingPackage.mode === "reinstall") {
        await request(`/api/provider/adapters/${pendingPackage.manifest.id}/uninstall`, { approved: true });
        await request("/api/provider/adapters/install", payload);
      } else if (pendingPackage.mode === "update") {
        await request("/api/provider/adapters/update", payload);
      } else {
        await request("/api/provider/adapters/install", payload);
      }
      setCandidate(null);
      setPendingPackage(null);
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

  const catalogStatus = (entry: ReviewedAdapterCatalogEntry): string => {
    if (entry.action === "current") {
      return entry.enabled === false ? "Installed · disabled" : "Installed";
    }
    if (entry.action === "update") return `Update available (${entry.installedVersion} → ${entry.version})`;
    if (entry.action === "reinstall-same") return "Installed · reviewed package differs";
    return "Not installed";
  };

  return (
    <OverlayDialog title="Provider adapters" onClose={onClose}>
      <div className="adapter-settings" ref={bodyRef}>
        <p className="adapter-policy">
          Reviewed adapters install in one click with an explicit approve step. Aldunis verifies the
          pinned digest, rejects executable package code, and keeps authority inside its ACP runtime
          and permission broker. You still need the matching CLI on this machine.
        </p>
        {!administrationAvailable && (
          <p className="context-error" role="status">Remote clients can inspect adapter readiness but cannot administer host adapters.</p>
        )}

        <section className="adapter-catalog" aria-label="Reviewed adapters">
          <h3>Reviewed adapters</h3>
          <p className="adapter-policy">
            First-party manifests shipped with Aldunis. Install the CLI, then approve the adapter.
          </p>
          {catalog.length === 0 && <p>No reviewed adapters are available in this install.</p>}
          {catalog.map((entry) => (
            <article key={entry.slug} className="adapter-catalog-card">
              <header>
                <div>
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.id}@{entry.version} · {catalogStatus(entry)}
                  </small>
                </div>
                <code title={entry.digest}>{entry.digest.slice(0, 19)}…</code>
              </header>
              <p>{entry.description}</p>
              <ul className="adapter-catalog-meta">
                <li>
                  CLI:{" "}
                  {entry.executableFound
                    ? `Found (${entry.executableNames[0]})`
                    : `Not found · ${entry.requiresCliHint}`}
                </li>
                {entry.website && (
                  <li>
                    <a href={entry.website} target="_blank" rel="noreferrer">
                      Provider docs
                    </a>
                  </li>
                )}
              </ul>
              <footer>
                {entry.action === "current" ? (
                  <Button type="button" size="sm" disabled aria-label={`${entry.name}: installed`}>
                    Installed
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={busy || !administrationAvailable || !entry.package}
                    // installLabel already names the product (e.g. "Install OpenCode");
                    // avoid "Install OpenCode for OpenCode".
                    aria-label={entry.installLabel}
                    onClick={() => void reviewCatalogEntry(entry)}
                  >
                    {entry.installLabel}
                  </Button>
                )}
                {entry.action === "current" && entry.installed && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !administrationAvailable}
                    aria-label={`Review package for ${entry.name}`}
                    onClick={() => void reviewCatalogEntry(entry)}
                  >
                    Review package
                  </Button>
                )}
              </footer>
            </article>
          ))}
        </section>

        <section className="adapter-list" aria-label="Installed provider adapters">
          <h3>Installed</h3>
          {adapters.length === 0 && <p>No declarative adapters installed yet.</p>}
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
                <button
                  type="button"
                  disabled={busy || !administrationAvailable}
                  aria-label={`${adapter.enabled ? "Disable" : "Enable"} ${adapter.manifest.presentation.name}`}
                  onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/${adapter.enabled ? "disable" : "enable"}`)}
                >
                  {adapter.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  disabled={busy || !administrationAvailable}
                  aria-label={`Rollback ${adapter.manifest.presentation.name}`}
                  onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/rollback`)}
                >
                  Rollback
                </button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy || !administrationAvailable}
                  aria-label={`Uninstall ${adapter.manifest.presentation.name}`}
                  onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/uninstall`)}
                >
                  Uninstall
                </Button>
              </footer>
            </article>
          ))}
        </section>

        {candidate && pendingPackage && (
          <section
            className="adapter-review"
            aria-label="Adapter approval review"
            ref={reviewRef}
          >
            <h3>
              {pendingPackage.mode === "update"
                ? "Review update"
                : pendingPackage.mode === "reinstall"
                ? "Review reinstall"
                : pendingPackage.mode === "view"
                ? "Reviewed package"
                : "Review installation"}
            </h3>
            <dl>
              <div>
                <dt>Source</dt>
                <dd>{candidate.source}</dd>
              </div>
              <div>
                <dt>Publisher claim</dt>
                <dd>{candidate.manifest.publisher.name} · not endorsed by Aldunis</dd>
              </div>
              <div>
                <dt>Integrity</dt>
                <dd>{candidate.digest}</dd>
              </div>
              <div>
                <dt>Compatibility</dt>
                <dd>
                  Aldunis {candidate.manifest.aldunis.minimumVersion}–{candidate.manifest.aldunis.maximumVersion}; ACP{" "}
                  {candidate.manifest.protocol.minimumVersion}
                </dd>
              </div>
              <div>
                <dt>Executable</dt>
                <dd>{candidate.manifest.executable.names.join(", ")}</dd>
              </div>
              <div>
                <dt>Fixed arguments</dt>
                <dd>{candidate.manifest.executable.arguments.join(" ") || "None"}</dd>
              </div>
              <div>
                <dt>Environment names</dt>
                <dd>
                  {candidate.manifest.environment
                    .map((item) => `${item.name}${item.required ? " (required)" : ""}`)
                    .join(", ") || "None"}
                </dd>
              </div>
              <div>
                <dt>Declared capabilities</dt>
                <dd>
                  {Object.entries(candidate.manifest.capabilities)
                    .filter(([, enabled]) => enabled)
                    .map(([name]) => name)
                    .join(", ") || "None"}
                </dd>
              </div>
              <div>
                <dt>Working directory</dt>
                <dd>Canonical conversation worktree</dd>
              </div>
              <div>
                <dt>Provider process authority</dt>
                <dd>
                  Runs as your local OS user. Aldunis bounds cwd and environment, but does not sandbox native
                  filesystem, process, or network access.
                </dd>
              </div>
              <div>
                <dt>Tool authority</dt>
                <dd>Cannot grant Aldunis tool authority; ACP mutations still require allow-once approval</dd>
              </div>
              {existing && (
                <div>
                  <dt>Currently installed</dt>
                  <dd>
                    {existing.manifest.version} · {existing.digest}
                  </dd>
                </div>
              )}
            </dl>
            <div className="adapter-review-actions">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setCandidate(null);
                  setPendingPackage(null);
                }}
              >
                Cancel
              </Button>
              {pendingPackage.mode !== "view" && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void approvePending()}
                >
                  {busy
                    ? "Working…"
                    : pendingPackage.mode === "update"
                    ? "Approve and update"
                    : pendingPackage.mode === "reinstall"
                    ? "Approve and reinstall"
                    : "Approve and install"}
                </Button>
              )}
            </div>
          </section>
        )}

        {administrationAvailable && (
          <section className="adapter-import" aria-label="Inspect a custom manifest">
            <button
              type="button"
              className="adapter-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              {advancedOpen ? "Hide advanced import" : "Advanced: inspect a custom manifest"}
            </button>
            {advancedOpen && (
              <>
                <p className="adapter-policy">
                  For third-party or local manifests. You must supply the source URL, pinned digest, and JSON yourself.
                </p>
                <div className="adapter-import-fields">
                  <label className="adapter-field" htmlFor="adapter-source-url">
                    <span>Source URL</span>
                    <input
                      id="adapter-source-url"
                      name="adapter-source-url"
                      value={source}
                      onChange={(event) => {
                        setSource(event.target.value);
                        setCandidate(null);
                        setPendingPackage(null);
                      }}
                      placeholder="file:///… or https://…"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="adapter-field" htmlFor="adapter-digest">
                    <span>Expected SHA-256 digest</span>
                    <input
                      id="adapter-digest"
                      name="adapter-digest"
                      value={digest}
                      onChange={(event) => {
                        setDigest(event.target.value);
                        setCandidate(null);
                        setPendingPackage(null);
                      }}
                      placeholder="sha256:…"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="adapter-field adapter-field-manifest" htmlFor="adapter-manifest-json">
                    <span>Manifest JSON</span>
                    <textarea
                      id="adapter-manifest-json"
                      name="adapter-manifest-json"
                      value={manifestText}
                      onChange={(event) => {
                        setManifestText(event.target.value);
                        setCandidate(null);
                        setPendingPackage(null);
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
              </>
            )}
          </section>
        )}
        {error && <p className="context-error" role="alert">{error}</p>}
      </div>
    </OverlayDialog>
  );
}
