import React, { useEffect, useState } from "react";
import { Button } from "../../components/ui";
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
  const [status, setStatus] = useState<RemoteConnectionStatus | null>(null);
  const [pairing, setPairing] = useState<PairingGrant | null>(null);
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

  useEffect(() => {
    if (!open) return;
    setPairing(null);
    setCopied(false);
    void loadStatus();
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

  if (!open) return null;
  return (
    <OverlayDialog title="Connections" onClose={onClose}>
      <div className="connections-dialog">
        <p className="connections-policy">
          Pairing and revocation are local-host controls. Remote devices can use a session, but cannot administer access.
        </p>
        {loading && <p role="status">Reading paired sessions…</p>}
        {error && <p className="connections-error" role="alert">{error}</p>}
        {!loading && status && (
          <>
            <section className="connections-summary" aria-label="Remote access status">
              <div><span>Status</span><strong>{status.remoteEnabled ? "Paired access enabled" : "Disabled"}</strong></div>
              <div><span>Host</span><code>{status.descriptor?.hostId ?? "Local-only host"}</code></div>
              {status.descriptor && <div><span>Protocol</span><code>v{status.descriptor.protocolVersion}</code></div>}
            </section>
            {status.remoteEnabled && (
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
          </>
        )}
      </div>
    </OverlayDialog>
  );
}
