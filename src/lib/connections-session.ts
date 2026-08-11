import { DEFAULT_SSH_REMOTE_PORT } from "../ports";

export interface RemoteSessionSummary {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface RemoteConnectionStatus {
  remoteEnabled: boolean;
  descriptor: { hostId: string; protocolVersion: 1 } | null;
  sessions: RemoteSessionSummary[];
}

export interface PairingGrant {
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

export interface ConnectionsDraft {
  transport: "endpoint" | "ssh";
  label: string;
  endpoint: string;
  pairingUrl: string;
  sshTarget: string;
  remotePort: string;
  remoteCommand: string;
  editingId: string | null;
}

export interface ConnectionsSnapshot {
  status: RemoteConnectionStatus | null;
  pairing: PairingGrant | null;
  environments: RemoteEnvironmentSummary[];
  formOpen: boolean;
  draft: ConnectionsDraft;
  environmentBusy: string | null;
  busy: boolean;
  loading: boolean;
  copied: boolean;
  error: string | null;
}

interface DesktopConnectionsAdapter {
  list(): Promise<RemoteEnvironmentSummary[]>;
  save(
    input: Record<string, unknown>,
  ): Promise<{ summary: RemoteEnvironmentSummary; pairingUrl: string | null }>;
  connect(id: string, pairingUrl: string | null, forcePair?: boolean): Promise<unknown>;
  disconnect(id: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  useLocal(): Promise<unknown>;
}

export interface ConnectionsSessionAdapters {
  localDesktop: boolean;
  remoteDesktop: boolean;
  canUseLocal: boolean;
  hostRequest<T>(route: string, body?: Record<string, unknown>): Promise<T>;
  desktop: DesktopConnectionsAdapter | null;
  copy(text: string): Promise<void>;
}

const emptyDraft = (): ConnectionsDraft => ({
  transport: "ssh",
  label: "",
  endpoint: "",
  pairingUrl: "",
  sshTarget: "",
  remotePort: String(DEFAULT_SSH_REMOTE_PORT),
  remoteCommand: "aldunis-code",
  editingId: null,
});

const initialSnapshot = (): ConnectionsSnapshot => ({
  status: null,
  pairing: null,
  environments: [],
  formOpen: false,
  draft: emptyDraft(),
  environmentBusy: null,
  busy: false,
  loading: false,
  copied: false,
  error: null,
});

/** Owns the renderer Connections lifecycle while host and desktop adapters retain authority. */
export class ConnectionsSessionModule {
  private snapshot = initialSnapshot();
  private listeners = new Set<() => void>();
  private generation = 0;

  constructor(private readonly adapters: ConnectionsSessionAdapters) {}

  getSnapshot = (): ConnectionsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(): void {
    const generation = ++this.generation;
    this.update({
      pairing: null,
      copied: false,
      busy: false,
      environmentBusy: null,
    });
    void this.load(generation);
  }

  close(): void {
    this.generation += 1;
  }

  updateDraft(patch: Partial<ConnectionsDraft>): void {
    this.update({ draft: { ...this.snapshot.draft, ...patch } });
  }

  showNewEnvironment(): void {
    this.update({ draft: emptyDraft(), formOpen: true });
  }

  hideEnvironmentForm(): void {
    this.update({ formOpen: false });
  }

  editPairing(environment: RemoteEnvironmentSummary): void {
    this.update({
      formOpen: true,
      draft: {
        transport: "endpoint",
        editingId: environment.id,
        label: environment.label,
        endpoint: environment.endpoint ?? "",
        pairingUrl: "",
        sshTarget: "",
        remotePort: String(environment.remotePort),
        remoteCommand: environment.remoteCommand,
      },
    });
  }

  async saveAndConnect(): Promise<void> {
    const desktop = this.localDesktopAdapter();
    if (!desktop) return;
    const generation = this.generation;
    this.update({ environmentBusy: "new", error: null });
    try {
      const draft = this.snapshot.draft;
      const saved = await desktop.save({
        ...(draft.editingId ? { id: draft.editingId } : {}),
        label: draft.label,
        transport: draft.transport,
        ...(draft.transport === "endpoint"
          ? {
              endpoint: draft.endpoint,
              ...(draft.pairingUrl.trim() ? { pairingUrl: draft.pairingUrl } : {}),
            }
          : {
              sshTarget: draft.sshTarget,
              remotePort: Number(draft.remotePort),
              remoteCommand: draft.remoteCommand,
            }),
      });
      await desktop.connect(saved.summary.id, saved.pairingUrl);
      if (this.isCurrent(generation)) this.update({ formOpen: false, draft: emptyDraft() });
    } catch (cause) {
      this.fail(cause, "The remote environment could not be connected.", generation);
    } finally {
      if (this.isCurrent(generation)) this.update({ environmentBusy: null });
    }
  }

  async connect(environment: RemoteEnvironmentSummary, forcePair = false): Promise<void> {
    const desktop = this.localDesktopAdapter();
    if (!desktop) return;
    const generation = this.generation;
    this.update({ environmentBusy: environment.id, error: null });
    try {
      await desktop.connect(environment.id, null, forcePair);
    } catch (cause) {
      this.fail(cause, "The remote environment could not be connected.", generation);
      await this.loadEnvironments(generation);
    } finally {
      if (this.isCurrent(generation)) this.update({ environmentBusy: null });
    }
  }

  async disconnect(environment: RemoteEnvironmentSummary): Promise<void> {
    await this.environmentMutation(
      environment,
      (desktop) => desktop.disconnect(environment.id),
      "The remote environment could not be disconnected.",
    );
  }

  async remove(environment: RemoteEnvironmentSummary): Promise<void> {
    await this.environmentMutation(
      environment,
      (desktop) => desktop.remove(environment.id),
      "The remote environment could not be removed.",
    );
  }

  async useLocal(): Promise<void> {
    const desktop = this.adapters.desktop;
    if (!desktop || !this.adapters.canUseLocal) return;
    const generation = this.generation;
    this.update({ environmentBusy: "local", error: null });
    try {
      await desktop.useLocal();
    } catch (cause) {
      this.fail(cause, "The local environment could not be restored.", generation);
    } finally {
      if (this.isCurrent(generation)) this.update({ environmentBusy: null });
    }
  }

  async createPairing(): Promise<void> {
    const generation = this.generation;
    this.update({ busy: true, error: null, copied: false });
    try {
      const pairing = await this.adapters.hostRequest<PairingGrant>("/api/remote/admin/pair");
      if (this.isCurrent(generation)) this.update({ pairing });
      await this.loadStatus(generation);
    } catch (cause) {
      this.fail(cause, "A pairing grant could not be created.", generation);
    } finally {
      if (this.isCurrent(generation)) this.update({ busy: false });
    }
  }

  async revoke(sessionId: string): Promise<void> {
    const generation = this.generation;
    this.update({ busy: true, error: null });
    try {
      await this.adapters.hostRequest("/api/remote/admin/revoke", { sessionId });
      await this.loadStatus(generation);
    } catch (cause) {
      this.fail(cause, "The remote session could not be revoked.", generation);
    } finally {
      if (this.isCurrent(generation)) this.update({ busy: false });
    }
  }

  async copyPairingLink(): Promise<void> {
    if (!this.snapshot.pairing) return;
    try {
      await this.adapters.copy(this.snapshot.pairing.pairingUrl);
      this.update({ copied: true });
    } catch {
      this.update({
        error: "The pairing link could not be copied. Select it and copy it manually.",
      });
    }
  }

  private async load(generation: number): Promise<void> {
    this.update({ loading: true, error: null });
    try {
      const environments =
        this.adapters.localDesktop && this.adapters.desktop
          ? await this.adapters.desktop.list()
          : [];
      if (!this.isCurrent(generation)) return;
      if (this.adapters.localDesktop) this.update({ environments });
      if (this.adapters.remoteDesktop) return;
      if (environments.some((environment) => environment.connected)) {
        this.update({ status: null });
        return;
      }
      await this.loadStatus(generation);
    } catch (cause) {
      if (this.isCurrent(generation)) {
        this.update({ status: null });
        this.fail(cause, "Connections could not be loaded.", generation);
      }
    } finally {
      if (this.isCurrent(generation)) this.update({ loading: false });
    }
  }

  private async loadStatus(generation: number): Promise<void> {
    const status = await this.adapters.hostRequest<RemoteConnectionStatus>(
      "/api/remote/admin/status",
    );
    if (this.isCurrent(generation)) this.update({ status });
  }

  private async loadEnvironments(generation: number): Promise<void> {
    const desktop = this.localDesktopAdapter();
    if (!desktop) return;
    try {
      const environments = await desktop.list();
      if (this.isCurrent(generation)) this.update({ environments });
    } catch (cause) {
      this.fail(cause, "Remote environments could not be loaded.", generation);
    }
  }

  private async environmentMutation(
    environment: RemoteEnvironmentSummary,
    mutate: (desktop: DesktopConnectionsAdapter) => Promise<unknown>,
    fallback: string,
  ): Promise<void> {
    const desktop = this.localDesktopAdapter();
    if (!desktop) return;
    const generation = this.generation;
    this.update({ environmentBusy: environment.id, error: null });
    try {
      await mutate(desktop);
      await this.loadEnvironments(generation);
    } catch (cause) {
      this.fail(cause, fallback, generation);
    } finally {
      if (this.isCurrent(generation)) this.update({ environmentBusy: null });
    }
  }

  private localDesktopAdapter(): DesktopConnectionsAdapter | null {
    return this.adapters.localDesktop ? this.adapters.desktop : null;
  }

  private fail(cause: unknown, fallback: string, generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.update({ error: cause instanceof Error ? cause.message : fallback });
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private update(patch: Partial<ConnectionsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
