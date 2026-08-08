import React, { FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui";
import {
  DEFAULT_DEV_HOST_PORT,
  DEFAULT_DEV_UI_PORT,
  DEFAULT_SSH_REMOTE_PORT,
} from "../../ports";
import { OverlayDialog } from "./overlay-dialog";

export interface RemoteSessionSummary {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface RemoteConnectionStatus {
  remoteEnabled: boolean;
  descriptor: { hostId: string; protocolVersion: 1 } | null;
  sessions: RemoteSessionSummary[];
}

interface PairingGrant {
  id: string;
  credential: string;
  expiresAt: string;
  pairingUrl: string;
}

export interface RemoteEnvironmentSummary {
  id: string;
  label: string;
  transport: "endpoint" | "ssh";
  endpoint: string | null;
  sshTarget: string | null;
  remotePort: number;
  remoteCommand: string;
  preferredLocalPort: number | null;
  paired: boolean;
  createdAt: string;
  updatedAt: string;
  connected: boolean;
  localUrl: string | null;
}

export function remoteSessionState(
  session: RemoteSessionSummary,
  now = Date.now(),
): "active" | "expired" | "revoked" {
  if (session.revokedAt) return "revoked";
  return Date.parse(session.expiresAt) <= now ? "expired" : "active";
}

export function formatConnectionDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Unknown time";
}

async function readJson<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The Connections action failed.");
  return result;
}

export function ConnectionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const desktop = window.aldunisDesktop;
  const desktopCapabilities = window.aldunisDesktopCapabilities;
  const localDesktop = Boolean(desktop && desktopCapabilities?.localApplication);
  const remoteDesktop = Boolean(desktop && desktopCapabilities?.remoteConnectionControls && !localDesktop);
  const [status, setStatus] = useState<RemoteConnectionStatus | null>(null);
  const [pairing, setPairing] = useState<PairingGrant | null>(null);
  const [environments, setEnvironments] = useState<RemoteEnvironmentSummary[]>([]);
  const [environmentFormOpen, setEnvironmentFormOpen] = useState(false);
  const [environmentTransport, setEnvironmentTransport] = useState<"endpoint" | "ssh">("ssh");
  const [environmentLabel, setEnvironmentLabel] = useState("");
  const [environmentEndpoint, setEnvironmentEndpoint] = useState("");
  const [environmentPairingUrl, setEnvironmentPairingUrl] = useState("");
  const [environmentSshTarget, setEnvironmentSshTarget] = useState("");
  const [environmentRemotePort, setEnvironmentRemotePort] = useState(String(DEFAULT_SSH_REMOTE_PORT));
  const [environmentRemoteCommand, setEnvironmentRemoteCommand] = useState("aldunis-code");
  const [environmentEditingId, setEnvironmentEditingId] = useState<string | null>(null);
  const [environmentBusy, setEnvironmentBusy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await readJson<RemoteConnectionStatus>("/api/remote/admin/status"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connections status could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  const loadEnvironments = async () => {
    if (!desktop || !localDesktop) return;
    try {
      setEnvironments(await desktop.listRemoteEnvironments() as RemoteEnvironmentSummary[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Remote environments could not be loaded.");
    }
  };

  const loadConnections = async () => {
    setLoading(true);
    setError(null);
    try {
      const nextEnvironments = localDesktop && desktop
        ? await desktop.listRemoteEnvironments() as RemoteEnvironmentSummary[]
        : [];
      if (localDesktop) setEnvironments(nextEnvironments);
      if (remoteDesktop) return;
      if (nextEnvironments.some((environment) => environment.connected)) {
        setStatus(null);
        return;
      }
      setStatus(await readJson<RemoteConnectionStatus>("/api/remote/admin/status"));
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : "Connections could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setPairing(null);
    setCopied(false);
    void loadConnections();
  }, [open]);

  const createPairing = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setPairing(await readJson<PairingGrant>("/api/remote/admin/pair"));
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A pairing grant could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const revokeSession = async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await readJson<{ revoked: boolean }>("/api/remote/admin/revoke", { sessionId });
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The remote session could not be revoked.");
    } finally {
      setBusy(false);
    }
  };

  const copyPairingLink = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairingUrl);
      setCopied(true);
    } catch {
      setError("The pairing link could not be copied. Select it and copy it manually.");
    }
  };

  const resetEnvironmentForm = () => {
    setEnvironmentEditingId(null);
    setEnvironmentLabel("");
    setEnvironmentEndpoint("");
    setEnvironmentPairingUrl("");
    setEnvironmentSshTarget("");
    setEnvironmentRemotePort(String(DEFAULT_SSH_REMOTE_PORT));
    setEnvironmentRemoteCommand("aldunis-code");
    setEnvironmentTransport("ssh");
  };

  const saveEnvironment = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop || !localDesktop) return;
    setEnvironmentBusy("new");
    setError(null);
    try {
      const saved = await desktop.saveRemoteEnvironment({
        ...(environmentEditingId ? { id: environmentEditingId } : {}),
        label: environmentLabel,
        transport: environmentTransport,
        ...(environmentTransport === "endpoint"
          ? {
              endpoint: environmentEndpoint,
              ...(environmentPairingUrl.trim() ? { pairingUrl: environmentPairingUrl } : {}),
            }
          : {
              sshTarget: environmentSshTarget,
              remotePort: Number(environmentRemotePort),
              remoteCommand: environmentRemoteCommand,
            }),
      });
      await desktop.connectRemoteEnvironment(saved.summary.id, saved.pairingUrl);
      setEnvironmentFormOpen(false);
      resetEnvironmentForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The remote environment could not be connected.");
    } finally {
      setEnvironmentBusy(null);
    }
  };

  const connectEnvironment = async (environment: RemoteEnvironmentSummary, forcePair = false) => {
    if (!desktop || !localDesktop) return;
    setEnvironmentBusy(environment.id);
    setError(null);
    try {
      await desktop.connectRemoteEnvironment(environment.id, null, forcePair);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The remote environment could not be connected.");
      await loadEnvironments();
    } finally {
      setEnvironmentBusy(null);
    }
  };

  const openPairingForm = (environment: RemoteEnvironmentSummary) => {
    setEnvironmentTransport("endpoint");
    setEnvironmentEditingId(environment.id);
    setEnvironmentLabel(environment.label);
    setEnvironmentEndpoint(environment.endpoint ?? "");
    setEnvironmentPairingUrl("");
    setEnvironmentSshTarget("");
    setEnvironmentRemotePort(String(environment.remotePort));
    setEnvironmentRemoteCommand(environment.remoteCommand);
    setEnvironmentFormOpen(true);
  };

  const disconnectEnvironment = async (environment: RemoteEnvironmentSummary) => {
    if (!desktop || !localDesktop) return;
    setEnvironmentBusy(environment.id);
    setError(null);
    try {
      await desktop.disconnectRemoteEnvironment(environment.id);
      await loadEnvironments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The remote environment could not be disconnected.");
    } finally {
      setEnvironmentBusy(null);
    }
  };

  const removeEnvironment = async (environment: RemoteEnvironmentSummary) => {
    if (!desktop || !localDesktop) return;
    setEnvironmentBusy(environment.id);
    setError(null);
    try {
      await desktop.removeRemoteEnvironment(environment.id);
      await loadEnvironments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The remote environment could not be removed.");
    } finally {
      setEnvironmentBusy(null);
    }
  };

  const useLocalEnvironment = async () => {
    if (!desktop || !desktopCapabilities?.remoteConnectionControls) return;
    setEnvironmentBusy("local");
    setError(null);
    try {
      await desktop.useLocalEnvironment();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The local environment could not be restored.");
    } finally {
      setEnvironmentBusy(null);
    }
  };

  if (!open) return null;
  return (
    <OverlayDialog title="Connections" onClose={onClose}>
      <div className="connections-dialog">
        <p className="connections-policy">
          Pairing and revocation are local-host controls. Remote devices can use a session, but cannot administer access.
        </p>
        {loading && <p role="status">Reading paired sessions…</p>}
        {error && <p className="connections-error" role="alert">{error}</p>}
        {!loading && (status || localDesktop || remoteDesktop) && (
          <>
            {status && (
              <section className="connections-summary" aria-label="Remote access status">
                <div><span>Status</span><strong>{status.remoteEnabled ? "Paired access enabled" : "Disabled"}</strong></div>
                <div><span>Host</span><code>{status.descriptor?.hostId ?? "Local-only host"}</code></div>
                {status.descriptor && <div><span>Protocol</span><code>v{status.descriptor.protocolVersion}</code></div>}
              </section>
            )}
            {localDesktop && (
              <section className="connections-environments" aria-labelledby="connections-environments-title">
                <div className="connections-section-heading">
                  <h3 id="connections-environments-title">Remote workbenches</h3>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      resetEnvironmentForm();
                      setEnvironmentFormOpen(true);
                    }}
                    disabled={environmentBusy !== null}
                  >
                    Add environment
                  </Button>
                </div>
                <p>
                  Saved environments keep the remote host authoritative for repositories, providers, and conversations.
                  SSH uses an inspectable local forward; private keys stay with your SSH agent.
                </p>
                {environments.length === 0 && <p>No remote workbenches saved yet.</p>}
                {environments.length > 0 && (
                  <ul className="connections-environment-list">
                    {environments.map((environment) => (
                      <li key={environment.id}>
                        <div>
                          <strong>{environment.label}</strong>
                          <small>
                            {environment.transport === "ssh"
                              ? `${environment.sshTarget} · remote port ${environment.remotePort}`
                              : environment.endpoint}
                          </small>
                          <small>
                            {environment.connected ? `connected${environment.localUrl ? ` · ${environment.localUrl}` : ""}` : "disconnected"}
                            {environment.transport === "ssh" && environment.preferredLocalPort
                              ? ` · local port ${environment.preferredLocalPort}`
                              : ""}
                          </small>
                        </div>
                        <div className="connections-environment-actions">
                          {environment.connected ? (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void disconnectEnvironment(environment)}
                              disabled={environmentBusy !== null}
                            >
                              Disconnect
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void connectEnvironment(environment)}
                              disabled={environmentBusy !== null}
                            >
                              {environmentBusy === environment.id ? "Connecting…" : "Connect"}
                            </Button>
                          )}
                          {!environment.connected && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => environment.transport === "ssh"
                                ? void connectEnvironment(environment, true)
                                : openPairingForm(environment)}
                              disabled={environmentBusy !== null}
                            >
                              {environment.paired ? "Pair again" : "Pair"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeEnvironment(environment)}
                            disabled={environmentBusy !== null}
                          >
                            Remove
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void useLocalEnvironment()}
                  disabled={environmentBusy !== null}
                >
                  Use local host
                </Button>
                {environmentFormOpen && (
                  <form className="connections-environment-form" onSubmit={(event) => void saveEnvironment(event)}>
                    <div className="connections-form-grid">
                      <label>
                        Name
                        <input
                          value={environmentLabel}
                          onChange={(event) => setEnvironmentLabel(event.target.value)}
                          placeholder="Build server"
                          autoComplete="off"
                          required
                        />
                      </label>
                      <label>
                        Connection type
                        <select value={environmentTransport} onChange={(event) => setEnvironmentTransport(event.target.value as "endpoint" | "ssh")}>
                          <option value="ssh">SSH launch / local forward</option>
                          <option value="endpoint">Existing HTTPS endpoint</option>
                        </select>
                      </label>
                    </div>
                    {environmentTransport === "ssh" ? (
                      <>
                        <label>
                          SSH target
                          <input
                            value={environmentSshTarget}
                            onChange={(event) => setEnvironmentSshTarget(event.target.value)}
                            placeholder="user@example.com or SSH config alias"
                            autoComplete="off"
                            required
                          />
                        </label>
                        <div className="connections-form-grid">
                          <label>
                            Remote backend port
                            <input
                              type="number"
                              min="1"
                              max="65535"
                              value={environmentRemotePort}
                              onChange={(event) => setEnvironmentRemotePort(event.target.value)}
                              required
                            />
                          </label>
                          <label>
                            Remote executable
                            <input
                              value={environmentRemoteCommand}
                              onChange={(event) => setEnvironmentRemoteCommand(event.target.value)}
                              autoComplete="off"
                              required
                            />
                          </label>
                        </div>
                        <p className="connections-form-hint">
                          SSH remote workbenches use port {DEFAULT_SSH_REMOTE_PORT} by default so they do not collide with Vite ({DEFAULT_DEV_UI_PORT}) or the split development host ({DEFAULT_DEV_HOST_PORT}). T3 Code uses 3773. SSH launch requires a compatible Aldunis executable and non-interactive key/agent access on the host.
                        </p>
                      </>
                    ) : (
                      <>
                        <label>
                          Backend URL
                          <input
                            type="url"
                            value={environmentEndpoint}
                            onChange={(event) => setEnvironmentEndpoint(event.target.value)}
                            placeholder="https://code.tailnet.example"
                            autoComplete="url"
                            required
                          />
                        </label>
                        <label>
                          One-time pairing URL <span>(required for first pairing)</span>
                          <input
                            type="url"
                            value={environmentPairingUrl}
                            onChange={(event) => setEnvironmentPairingUrl(event.target.value)}
                            placeholder="https://code.tailnet.example/#pair=…"
                            autoComplete="off"
                            required
                          />
                        </label>
                        <p className="connections-form-hint">
                          The pairing credential is used once and is never saved in the desktop connection record.
                        </p>
                      </>
                    )}
                    <div className="connections-form-actions">
                      <Button type="button" size="sm" onClick={() => setEnvironmentFormOpen(false)} disabled={environmentBusy !== null}>Cancel</Button>
                      <Button type="submit" size="sm" variant="primary" disabled={environmentBusy !== null}>
                        {environmentBusy === "new" ? "Connecting…" : "Save and connect"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>
            )}
            {remoteDesktop && (
              <section className="connections-environments" aria-labelledby="connections-active-title">
                <div className="connections-section-heading">
                  <h3 id="connections-active-title">Remote workbench active</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void useLocalEnvironment()}
                    disabled={environmentBusy !== null}
                  >
                    Use local host
                  </Button>
                </div>
                <p>Local folders, browser controls, and connection administration are unavailable while this remote workbench is open.</p>
              </section>
            )}
            {status?.remoteEnabled && (
              <section className="connections-pairing" aria-labelledby="connections-pairing-title">
                <div className="connections-section-heading">
                  <h3 id="connections-pairing-title">Pair a device</h3>
                  <Button type="button" size="sm" onClick={() => void createPairing()} disabled={busy}>
                    {busy ? "Creating…" : "Create one-time link"}
                  </Button>
                </div>
                <p>Grants expire quickly and can be redeemed once. The resulting device session lasts until expiry or revocation.</p>
                {pairing && (
                  <div className="connections-grant">
                    <label htmlFor="connections-pairing-link">Pairing link · expires {formatConnectionDate(pairing.expiresAt)}</label>
                    <input id="connections-pairing-link" readOnly value={pairing.pairingUrl} onFocus={(event) => event.currentTarget.select()} />
                    <Button type="button" size="sm" onClick={() => void copyPairingLink()}>
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                  </div>
                )}
              </section>
            )}
            {status && (
              <section className="connections-sessions" aria-labelledby="connections-sessions-title">
                <h3 id="connections-sessions-title">Paired sessions</h3>
                {status.sessions.length === 0 && <p>No paired devices.</p>}
                {status.sessions.length > 0 && (
                  <ul>
                    {status.sessions.map((session) => {
                      const state = remoteSessionState(session);
                      return (
                        <li key={session.id}>
                          <div>
                            <strong>{session.label}</strong>
                            <small>{state} · expires {formatConnectionDate(session.expiresAt)}</small>
                          </div>
                          {state === "active" && (
                            <Button type="button" size="sm" onClick={() => void revokeSession(session.id)} disabled={busy}>
                              Revoke
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </OverlayDialog>
  );
}
