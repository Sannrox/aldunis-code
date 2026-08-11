import React, { useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "../../components/ui";
import { DEFAULT_DEV_HOST_PORT, DEFAULT_DEV_UI_PORT, DEFAULT_SSH_REMOTE_PORT } from "../../ports";
import { OverlayDialog } from "./overlay-dialog";
import {
  ConnectionsSessionModule,
  type RemoteEnvironmentSummary,
  type RemoteSessionSummary,
} from "../../lib/connections-session";

export type { RemoteEnvironmentSummary, RemoteSessionSummary } from "../../lib/connections-session";

export function remoteSessionState(
  session: RemoteSessionSummary,
  now = Date.now(),
): "active" | "expired" | "revoked" {
  if (session.revokedAt) return "revoked";
  return Date.parse(session.expiresAt) <= now ? "expired" : "active";
}

export function formatConnectionDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
}

async function readJson<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The Connections action failed.");
  return result;
}

export function ConnectionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const desktop = window.aldunisDesktop;
  const desktopCapabilities = window.aldunisDesktopCapabilities;
  const localDesktop = Boolean(desktop && desktopCapabilities?.localApplication);
  const remoteDesktop = Boolean(
    desktop && desktopCapabilities?.remoteConnectionControls && !localDesktop,
  );
  const session = useMemo(
    () =>
      new ConnectionsSessionModule({
        localDesktop,
        remoteDesktop,
        canUseLocal: Boolean(desktop && desktopCapabilities?.remoteConnectionControls),
        hostRequest: readJson,
        desktop: desktop
          ? {
              list: async () =>
                desktop.listRemoteEnvironments() as Promise<RemoteEnvironmentSummary[]>,
              save: (input) =>
                desktop.saveRemoteEnvironment(
                  input as Parameters<typeof desktop.saveRemoteEnvironment>[0],
                ),
              connect: (id, pairingUrl, forcePair) =>
                desktop.connectRemoteEnvironment(id, pairingUrl, forcePair),
              disconnect: (id) => desktop.disconnectRemoteEnvironment(id),
              remove: (id) => desktop.removeRemoteEnvironment(id),
              useLocal: () => desktop.useLocalEnvironment(),
            }
          : null,
        copy: (text) => navigator.clipboard.writeText(text),
      }),
    [desktop, desktopCapabilities?.remoteConnectionControls, localDesktop, remoteDesktop],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const {
    status,
    pairing,
    environments,
    formOpen: environmentFormOpen,
    draft,
    environmentBusy,
    busy,
    loading,
    copied,
    error,
  } = snapshot;
  const {
    transport: environmentTransport,
    label: environmentLabel,
    endpoint: environmentEndpoint,
    pairingUrl: environmentPairingUrl,
    sshTarget: environmentSshTarget,
    remotePort: environmentRemotePort,
    remoteCommand: environmentRemoteCommand,
  } = draft;

  useEffect(() => {
    if (!open) return;
    session.open();
    return () => session.close();
  }, [open, session]);

  if (!open) return null;
  return (
    <OverlayDialog title="Connections" onClose={onClose}>
      <div className="connections-dialog">
        <p className="connections-policy">
          Pairing and revocation are local-host controls. Remote devices can use a session, but
          cannot administer access.
        </p>
        {loading && <p role="status">Reading paired sessions…</p>}
        {error && (
          <p className="connections-error" role="alert">
            {error}
          </p>
        )}
        {!loading && (status || localDesktop || remoteDesktop) && (
          <>
            {status && (
              <section className="connections-summary" aria-label="Remote access status">
                <div>
                  <span>Status</span>
                  <strong>{status.remoteEnabled ? "Paired access enabled" : "Disabled"}</strong>
                </div>
                <div>
                  <span>Host</span>
                  <code>{status.descriptor?.hostId ?? "Local-only host"}</code>
                </div>
                {status.descriptor && (
                  <div>
                    <span>Protocol</span>
                    <code>v{status.descriptor.protocolVersion}</code>
                  </div>
                )}
              </section>
            )}
            {localDesktop && (
              <section
                className="connections-environments"
                aria-labelledby="connections-environments-title"
              >
                <div className="connections-section-heading">
                  <h3 id="connections-environments-title">Remote workbenches</h3>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      session.showNewEnvironment();
                    }}
                    disabled={environmentBusy !== null}
                  >
                    Add environment
                  </Button>
                </div>
                <p>
                  Saved environments keep the remote host authoritative for repositories, providers,
                  and conversations. SSH uses an inspectable local forward; private keys stay with
                  your SSH agent.
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
                            {environment.connected
                              ? `connected${environment.localUrl ? ` · ${environment.localUrl}` : ""}`
                              : "disconnected"}
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
                              onClick={() => void session.disconnect(environment)}
                              disabled={environmentBusy !== null}
                            >
                              Disconnect
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void session.connect(environment)}
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
                              onClick={() =>
                                environment.transport === "ssh"
                                  ? void session.connect(environment, true)
                                  : session.editPairing(environment)
                              }
                              disabled={environmentBusy !== null}
                            >
                              {environment.paired ? "Pair again" : "Pair"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void session.remove(environment)}
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
                  onClick={() => void session.useLocal()}
                  disabled={environmentBusy !== null}
                >
                  Use local host
                </Button>
                {environmentFormOpen && (
                  <form
                    className="connections-environment-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void session.saveAndConnect();
                    }}
                  >
                    <div className="connections-form-grid">
                      <label>
                        Name
                        <input
                          value={environmentLabel}
                          onChange={(event) => session.updateDraft({ label: event.target.value })}
                          placeholder="Build server"
                          autoComplete="off"
                          required
                        />
                      </label>
                      <label>
                        Connection type
                        <select
                          value={environmentTransport}
                          onChange={(event) =>
                            session.updateDraft({
                              transport: event.target.value as "endpoint" | "ssh",
                            })
                          }
                        >
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
                            onChange={(event) =>
                              session.updateDraft({ sshTarget: event.target.value })
                            }
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
                              onChange={(event) =>
                                session.updateDraft({ remotePort: event.target.value })
                              }
                              required
                            />
                          </label>
                          <label>
                            Remote executable
                            <input
                              value={environmentRemoteCommand}
                              onChange={(event) =>
                                session.updateDraft({ remoteCommand: event.target.value })
                              }
                              autoComplete="off"
                              required
                            />
                          </label>
                        </div>
                        <p className="connections-form-hint">
                          SSH remote workbenches use port {DEFAULT_SSH_REMOTE_PORT} by default so
                          they do not collide with Vite ({DEFAULT_DEV_UI_PORT}) or the split
                          development host ({DEFAULT_DEV_HOST_PORT}). T3 Code uses 3773. SSH launch
                          requires a compatible Aldunis executable and non-interactive key/agent
                          access on the host.
                        </p>
                      </>
                    ) : (
                      <>
                        <label>
                          Backend URL
                          <input
                            type="url"
                            value={environmentEndpoint}
                            onChange={(event) =>
                              session.updateDraft({ endpoint: event.target.value })
                            }
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
                            onChange={(event) =>
                              session.updateDraft({ pairingUrl: event.target.value })
                            }
                            placeholder="https://code.tailnet.example/#pair=…"
                            autoComplete="off"
                            required
                          />
                        </label>
                        <p className="connections-form-hint">
                          The pairing credential is used once and is never saved in the desktop
                          connection record.
                        </p>
                      </>
                    )}
                    <div className="connections-form-actions">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => session.hideEnvironmentForm()}
                        disabled={environmentBusy !== null}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        disabled={environmentBusy !== null}
                      >
                        {environmentBusy === "new" ? "Connecting…" : "Save and connect"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>
            )}
            {remoteDesktop && (
              <section
                className="connections-environments"
                aria-labelledby="connections-active-title"
              >
                <div className="connections-section-heading">
                  <h3 id="connections-active-title">Remote workbench active</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void session.useLocal()}
                    disabled={environmentBusy !== null}
                  >
                    Use local host
                  </Button>
                </div>
                <p>
                  Local folders, browser controls, and connection administration are unavailable
                  while this remote workbench is open.
                </p>
              </section>
            )}
            {status?.remoteEnabled && (
              <section className="connections-pairing" aria-labelledby="connections-pairing-title">
                <div className="connections-section-heading">
                  <h3 id="connections-pairing-title">Pair a device</h3>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void session.createPairing()}
                    disabled={busy}
                  >
                    {busy ? "Creating…" : "Create one-time link"}
                  </Button>
                </div>
                <p>
                  Grants expire quickly and can be redeemed once. The resulting device session lasts
                  until expiry or revocation.
                </p>
                {pairing && (
                  <div className="connections-grant">
                    <label htmlFor="connections-pairing-link">
                      Pairing link · expires {formatConnectionDate(pairing.expiresAt)}
                    </label>
                    <input
                      id="connections-pairing-link"
                      readOnly
                      value={pairing.pairingUrl}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button type="button" size="sm" onClick={() => void session.copyPairingLink()}>
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                  </div>
                )}
              </section>
            )}
            {status && (
              <section
                className="connections-sessions"
                aria-labelledby="connections-sessions-title"
              >
                <h3 id="connections-sessions-title">Paired sessions</h3>
                {status.sessions.length === 0 && <p>No paired devices.</p>}
                {status.sessions.length > 0 && (
                  <ul>
                    {status.sessions.map((remoteSession) => {
                      const state = remoteSessionState(remoteSession);
                      return (
                        <li key={remoteSession.id}>
                          <div>
                            <strong>{remoteSession.label}</strong>
                            <small>
                              {state} · expires {formatConnectionDate(remoteSession.expiresAt)}
                            </small>
                          </div>
                          {state === "active" && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void session.revoke(remoteSession.id)}
                              disabled={busy}
                            >
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
