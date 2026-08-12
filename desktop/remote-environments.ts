import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_SSH_REMOTE_PORT } from "../src/ports.ts";

export const DEFAULT_REMOTE_BACKEND_PORT = DEFAULT_SSH_REMOTE_PORT;
export const DEFAULT_REMOTE_COMMAND = "aldunis-code";
export const MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS = 8;

export type RemoteEnvironmentTransport = "endpoint" | "ssh";

export interface RemoteEnvironmentInput {
  id?: string;
  label: string;
  transport: RemoteEnvironmentTransport;
  endpoint?: string;
  pairingUrl?: string;
  sshTarget?: string;
  remotePort?: number;
  remoteCommand?: string;
}

export interface RemoteEnvironmentRecord {
  id: string;
  label: string;
  transport: RemoteEnvironmentTransport;
  endpoint: string | null;
  sshTarget: string | null;
  remotePort: number;
  remoteCommand: string;
  preferredLocalPort: number | null;
  paired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteEnvironmentSummary extends RemoteEnvironmentRecord {
  connected: boolean;
  localUrl: string | null;
}

export interface RemoteConnectionTarget {
  id: string;
  url: string;
  localUrl: string | null;
}

interface PersistedState {
  schemaVersion: 1;
  environments: RemoteEnvironmentRecord[];
}

interface ActiveConnection {
  tunnel: ChildProcess | null;
  remoteServer: ChildProcess | null;
  localUrl: string;
  cleanup?: () => void;
}

interface ConnectingEnvironment {
  operationKey: string;
  promise: Promise<RemoteConnectionTarget>;
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function assertLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("A connection name is required.");
  const label = value.trim();
  if (!label || label.length > 80)
    throw new Error("Connection names must be between 1 and 80 characters.");
  return label;
}

function assertEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("An HTTPS backend URL is required.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The backend URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Remote backend URLs must be HTTPS origins without credentials, queries, or fragments.",
    );
  }
  if (url.pathname !== "/") throw new Error("Remote backend URLs must be origins, not paths.");
  return url.origin;
}

function assertPairingUrl(value: unknown, endpoint: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("The pairing URL is invalid.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The pairing URL is invalid.");
  }
  if (
    url.origin !== endpoint ||
    url.pathname !== "/" ||
    url.search ||
    !/^#pair=[A-Za-z0-9_-]{20,}$/.test(url.hash)
  ) {
    throw new Error(
      "The pairing URL must belong to the backend and contain one pairing credential.",
    );
  }
  return url.toString();
}

function assertSshTarget(value: unknown): string {
  if (typeof value !== "string") throw new Error("An SSH target is required.");
  const target = value.trim();
  if (
    !target ||
    target.length > 160 ||
    target.startsWith("-") ||
    /[\0\s;&|$`()<>\\'"]/.test(target)
  ) {
    throw new Error(
      "SSH targets must be host aliases or user@host values without whitespace or option prefixes.",
    );
  }
  return target;
}

function assertRemoteCommand(value: unknown): string {
  if (value === undefined) return DEFAULT_REMOTE_COMMAND;
  if (typeof value !== "string") throw new Error("The remote executable is invalid.");
  const command = value.trim();
  if (!/^(?:[A-Za-z0-9_.-]+|\/[A-Za-z0-9_./-]+)$/.test(command)) {
    throw new Error(
      "The remote executable must be one command path without arguments or shell syntax.",
    );
  }
  return command;
}

function assertRemotePort(value: unknown): number {
  const port = value === undefined ? DEFAULT_REMOTE_BACKEND_PORT : value;
  if (typeof port !== "number" || !isValidPort(port)) {
    throw new Error("The remote backend port must be an integer between 1 and 65535.");
  }
  return port;
}

function parseRecord(value: unknown): RemoteEnvironmentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Remote environment state is invalid.");
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== "string" ||
    typeof input.label !== "string" ||
    (input.transport !== "endpoint" && input.transport !== "ssh") ||
    (input.endpoint !== null && typeof input.endpoint !== "string") ||
    (input.sshTarget !== null && typeof input.sshTarget !== "string") ||
    typeof input.remotePort !== "number" ||
    typeof input.remoteCommand !== "string" ||
    (input.preferredLocalPort !== null && typeof input.preferredLocalPort !== "number") ||
    typeof input.paired !== "boolean" ||
    typeof input.createdAt !== "string" ||
    typeof input.updatedAt !== "string"
  ) {
    throw new Error("Remote environment state is corrupt or incompatible.");
  }
  const record: RemoteEnvironmentRecord = {
    id: input.id,
    label: input.label,
    transport: input.transport,
    endpoint: input.endpoint,
    sshTarget: input.sshTarget,
    remotePort: input.remotePort,
    remoteCommand: input.remoteCommand,
    preferredLocalPort: input.preferredLocalPort,
    paired: input.paired,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  if (
    !record.id ||
    !record.label ||
    !isValidPort(record.remotePort) ||
    (record.preferredLocalPort !== null && !isValidPort(record.preferredLocalPort))
  ) {
    throw new Error("Remote environment state is corrupt or incompatible.");
  }
  if (record.transport === "endpoint" && !record.endpoint)
    throw new Error("Remote environment state is missing its endpoint.");
  if (record.transport === "ssh" && !record.sshTarget)
    throw new Error("Remote environment state is missing its SSH target.");
  return record;
}

export function normalizeRemoteEnvironmentInput(input: RemoteEnvironmentInput): {
  record: Omit<
    RemoteEnvironmentRecord,
    "id" | "createdAt" | "updatedAt" | "preferredLocalPort" | "paired"
  >;
  pairingUrl: string | null;
} {
  const label = assertLabel(input.label);
  const transport = input.transport;
  if (transport !== "endpoint" && transport !== "ssh")
    throw new Error("Choose a supported connection type.");
  if (transport === "endpoint") {
    const endpoint = assertEndpoint(input.endpoint);
    return {
      record: {
        label,
        transport,
        endpoint,
        sshTarget: null,
        remotePort: assertRemotePort(input.remotePort),
        remoteCommand: assertRemoteCommand(input.remoteCommand),
      },
      pairingUrl: input.pairingUrl ? assertPairingUrl(input.pairingUrl, endpoint) : null,
    };
  }
  return {
    record: {
      label,
      transport,
      endpoint: null,
      sshTarget: assertSshTarget(input.sshTarget),
      remotePort: assertRemotePort(input.remotePort),
      remoteCommand: assertRemoteCommand(input.remoteCommand),
    },
    pairingUrl: null,
  };
}

export function buildSshForwardArguments(
  target: string,
  localPort: number,
  remotePort: number,
): string[] {
  return [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=30",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    target,
  ];
}

export function buildSshServerArguments(
  target: string,
  command: string,
  remotePort: number,
): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    target,
    command,
    "serve",
    "--remote",
    "ssh",
    "--host",
    "127.0.0.1",
    "--port",
    String(remotePort),
  ];
}

export function buildSshPairingArguments(target: string, command: string): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    target,
    command,
    "auth",
    "pairing",
    "create",
  ];
}

async function portIsAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolve) => {
    const finish = (available: boolean) => {
      server.removeAllListeners();
      server.close(() => resolve(available));
    };
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => finish(true));
  });
}

async function selectLocalPort(preferred: number | null): Promise<number> {
  if (preferred !== null && (await portIsAvailable(preferred))) return preferred;
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        void server.close();
        reject(new Error("The SSH forward did not receive a local TCP port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function captureOutput(child: ChildProcess): { read: () => string } {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-8_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => append(`SSH process error: ${error.message}`));
  return { read: () => output.trim() };
}

export async function terminateRemoteChild(
  child: ChildProcess | null,
  graceMs = 1_000,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    let closeTimer: NodeJS.Timeout | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (closeTimer) clearTimeout(closeTimer);
      forceTimer = null;
      closeTimer = null;
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish();
    child.once("close", onClose);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      finish(error instanceof Error ? error : new Error("The SSH child could not be stopped."));
      return;
    }
    if (settled) return;
    forceTimer = setTimeout(
      () => {
        forceTimer = null;
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch (error) {
          finish(
            error instanceof Error ? error : new Error("The SSH child could not be force-stopped."),
          );
          return;
        }
        closeTimer = setTimeout(
          () => finish(new Error("The SSH child did not close after forced termination.")),
          Math.max(1, graceMs),
        );
        closeTimer.unref();
      },
      Math.max(0, graceMs),
    );
    forceTimer.unref();
  });
}

async function waitForRemoteDescriptor(
  localUrl: string,
  children: ChildProcess[],
): Promise<{ remoteEnabled: boolean }> {
  const deadline = Date.now() + 12_000;
  let lastError = "";
  let childError: Error | null = null;
  const onChildError = (error: Error) => {
    childError = error;
  };
  for (const child of children) child.once("error", onChildError);
  try {
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (children.some((child) => child.exitCode !== null && child.exitCode !== 0)) {
        // A remote server can exit because the requested port is already in use;
        // the existing server is still usable, so keep probing before failing.
      }
      try {
        const response = await fetch(`${localUrl}/api/remote/descriptor`, {
          method: "POST",
          signal: AbortSignal.timeout(1_000),
        });
        if (!response.ok) {
          lastError = `Remote descriptor returned HTTP ${response.status}.`;
        } else {
          const body = (await response.json()) as { remoteEnabled?: unknown };
          if (typeof body.remoteEnabled === "boolean") return { remoteEnabled: body.remoteEnabled };
          lastError = "The remote descriptor was invalid.";
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "The remote backend is not reachable.";
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(lastError || "The remote backend did not become reachable.");
  } finally {
    for (const child of children) child.off("error", onChildError);
  }
}

export function assertSshRemoteDescriptor(descriptor: { remoteEnabled: boolean }): void {
  if (!descriptor.remoteEnabled) {
    throw new Error("The SSH remote host did not enable authenticated remote access.");
  }
}

async function issueSshPairing(target: string, command: string, localUrl: string): Promise<string> {
  const child = spawn("ssh", buildSshPairingArguments(target, command), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-8_000);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      void terminateRemoteChild(child).catch(() => undefined);
      settled = true;
      reject(new Error("The remote host did not issue a pairing grant in time."));
    }, 12_000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    child.once("error", (error) =>
      fail(new Error(`The SSH pairing command could not start: ${error.message}`)),
    );
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = stderr.trim();
        reject(
          new Error(detail || `The SSH pairing command exited with ${signal ?? `status ${code}`}.`),
        );
        return;
      }
      let credential: unknown;
      try {
        credential = (JSON.parse(stdout.trim()) as { credential?: unknown }).credential;
      } catch {
        reject(new Error("The remote host returned an invalid pairing grant."));
        return;
      }
      if (typeof credential !== "string" || !/^[A-Za-z0-9_-]{20,}$/.test(credential)) {
        reject(new Error("The remote host returned an invalid pairing credential."));
        return;
      }
      const pairingUrl = new URL(localUrl);
      pairingUrl.hash = `pair=${credential}`;
      resolve(pairingUrl.toString());
    });
  });
}

export class RemoteEnvironmentStore {
  constructor(private readonly path: string) {}

  async list(): Promise<RemoteEnvironmentRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as PersistedState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.environments))
        throw new Error("incompatible");
      return parsed.environments.map(parseRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof Error && error.message.includes("Remote environment state")) throw error;
      throw new Error("Remote environment state is corrupt or incompatible.");
    }
  }

  async save(
    input: RemoteEnvironmentInput,
  ): Promise<{ record: RemoteEnvironmentRecord; pairingUrl: string | null }> {
    const normalized = normalizeRemoteEnvironmentInput(input);
    const environments = await this.list();
    const now = new Date().toISOString();
    const existing = input.id
      ? environments.find((environment) => environment.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("The remote environment no longer exists.");
    const record: RemoteEnvironmentRecord = {
      ...normalized.record,
      id: existing?.id ?? randomUUID(),
      preferredLocalPort: existing?.preferredLocalPort ?? null,
      paired: normalized.pairingUrl ? false : (existing?.paired ?? false),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? environments.map((environment) => (environment.id === record.id ? record : environment))
      : [...environments, record];
    await this.#write(next);
    return { record, pairingUrl: normalized.pairingUrl };
  }

  async updateRuntime(
    id: string,
    values: Partial<Pick<RemoteEnvironmentRecord, "preferredLocalPort" | "paired">>,
  ): Promise<void> {
    const environments = await this.list();
    const next = environments.map((environment) =>
      environment.id === id
        ? { ...environment, ...values, updatedAt: new Date().toISOString() }
        : environment,
    );
    if (!next.some((environment) => environment.id === id))
      throw new Error("The remote environment no longer exists.");
    await this.#write(next);
  }

  async remove(id: string): Promise<void> {
    const environments = await this.list();
    await this.#write(environments.filter((environment) => environment.id !== id));
  }

  async #write(environments: RemoteEnvironmentRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, environments }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }
}

export class RemoteEnvironmentManager {
  readonly #active = new Map<string, ActiveConnection>();
  readonly #connecting = new Map<string, ConnectingEnvironment>();
  readonly #disconnecting = new Map<string, Promise<void>>();
  #runtimeMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RemoteEnvironmentStore,
    private readonly onConnectionLost?: (id: string) => void,
  ) {}

  async list(): Promise<RemoteEnvironmentSummary[]> {
    const records = await this.store.list();
    return records.map((record) => {
      const active = this.#active.get(record.id);
      return { ...record, connected: Boolean(active), localUrl: active?.localUrl ?? null };
    });
  }

  async save(
    input: RemoteEnvironmentInput,
  ): Promise<{ summary: RemoteEnvironmentSummary; pairingUrl: string | null }> {
    const saved = await this.store.save(input);
    const summary = (await this.list()).find((environment) => environment.id === saved.record.id);
    if (!summary) throw new Error("The remote environment could not be saved.");
    return { summary, pairingUrl: saved.pairingUrl };
  }

  async confirmPairing(id: string): Promise<void> {
    if (!this.#active.has(id)) throw new Error("The remote environment is no longer connected.");
    await this.#updateRuntime(id, { paired: true });
  }

  connect(
    id: string,
    pairingUrl: string | null = null,
    forcePair = false,
  ): Promise<RemoteConnectionTarget> {
    if (this.#disconnecting.has(id)) {
      return Promise.reject(new Error("This remote environment is still disconnecting."));
    }
    const operationKey = JSON.stringify([pairingUrl, forcePair]);
    const connecting = this.#connecting.get(id);
    if (connecting) {
      if (connecting.operationKey === operationKey) return connecting.promise;
      return Promise.reject(
        new Error("A different connection request is already active for this environment."),
      );
    }
    const existing = this.#active.get(id);
    if (existing && !pairingUrl) {
      return Promise.resolve({ id, url: existing.localUrl, localUrl: existing.localUrl });
    }
    if (
      !existing &&
      new Set([...this.#active.keys(), ...this.#connecting.keys()]).size >=
        MAX_ACTIVE_REMOTE_ENVIRONMENT_CONNECTIONS
    ) {
      return Promise.reject(new Error("Too many remote environments are already connected."));
    }
    const pending = this.#connect(id, pairingUrl, forcePair).finally(() => {
      if (this.#connecting.get(id)?.promise === pending) this.#connecting.delete(id);
    });
    this.#connecting.set(id, { operationKey, promise: pending });
    return pending;
  }

  async #connect(
    id: string,
    pairingUrl: string | null,
    forcePair: boolean,
  ): Promise<RemoteConnectionTarget> {
    const records = await this.store.list();
    const record = records.find((environment) => environment.id === id);
    if (!record) throw new Error("The remote environment no longer exists.");
    const existing = this.#active.get(id);
    if (existing) {
      if (pairingUrl) {
        await this.#updateRuntime(id, { paired: false });
        return { id, url: pairingUrl, localUrl: existing.localUrl };
      }
      return { id, url: existing.localUrl, localUrl: existing.localUrl };
    }

    if (record.transport === "endpoint") {
      if (!record.endpoint) throw new Error("The remote environment endpoint is missing.");
      if (forcePair && !pairingUrl)
        throw new Error("Provide a new one-time pairing URL to pair this endpoint again.");
      if (!pairingUrl && !record.paired)
        throw new Error("Provide a one-time pairing URL before connecting this endpoint.");
      this.#active.set(id, { tunnel: null, remoteServer: null, localUrl: record.endpoint });
      if (pairingUrl) {
        await this.#updateRuntime(id, { paired: false });
        return { id, url: pairingUrl, localUrl: null };
      }
      return { id, url: record.endpoint, localUrl: null };
    }

    if (!record.sshTarget) throw new Error("The remote environment SSH target is missing.");
    const localPort = await selectLocalPort(record.preferredLocalPort);
    const localUrl = `http://127.0.0.1:${localPort}`;
    const remoteServer = spawn(
      "ssh",
      buildSshServerArguments(record.sshTarget, record.remoteCommand, record.remotePort),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const serverOutput = captureOutput(remoteServer);
    const tunnel = spawn(
      "ssh",
      buildSshForwardArguments(record.sshTarget, localPort, record.remotePort),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const tunnelOutput = captureOutput(tunnel);
    const activeConnection: ActiveConnection = { tunnel, remoteServer, localUrl };
    const onTunnelExit = () => {
      if (this.#active.get(id) !== activeConnection) return;
      this.#active.delete(id);
      activeConnection.cleanup?.();
      void Promise.all([
        terminateRemoteChild(activeConnection.tunnel),
        terminateRemoteChild(activeConnection.remoteServer),
      ]).catch(() => undefined);
      this.onConnectionLost?.(id);
    };
    const onRemoteServerExit = () => {
      if (this.#active.get(id) !== activeConnection) return;
      activeConnection.remoteServer = null;
      remoteServer.off("exit", onRemoteServerExit);
      remoteServer.off("error", onRemoteServerExit);
    };
    activeConnection.cleanup = () => {
      tunnel.off("exit", onTunnelExit);
      tunnel.off("error", onTunnelExit);
      remoteServer.off("exit", onRemoteServerExit);
      remoteServer.off("error", onRemoteServerExit);
    };
    tunnel.on("exit", onTunnelExit);
    tunnel.on("error", onTunnelExit);
    remoteServer.on("exit", onRemoteServerExit);
    remoteServer.on("error", onRemoteServerExit);
    this.#active.set(id, activeConnection);
    try {
      // The launch process may exit when the requested remote port is already
      // served by a compatible backend. The tunnel remains the live transport.
      const descriptor = await waitForRemoteDescriptor(localUrl, [tunnel]);
      assertSshRemoteDescriptor(descriptor);
      if (this.#active.get(id) !== activeConnection)
        throw new Error("The SSH remote transport exited before it was ready.");
      let url = localUrl;
      const localOriginChanged =
        record.preferredLocalPort !== null && record.preferredLocalPort !== localPort;
      const shouldPair = forcePair || !record.paired || localOriginChanged;
      if (shouldPair) {
        url = await issueSshPairing(record.sshTarget, record.remoteCommand, localUrl);
        if (!url.startsWith(`${localUrl}/#pair=`)) {
          throw new Error("The remote host returned a pairing URL for another origin.");
        }
        await this.#updateRuntime(id, { paired: false, preferredLocalPort: localPort });
      } else {
        await this.#updateRuntime(id, { preferredLocalPort: localPort });
      }
      if (this.#active.get(id) !== activeConnection)
        throw new Error("The SSH remote transport exited before it was ready.");
      return { id, url, localUrl };
    } catch (error) {
      activeConnection.cleanup?.();
      this.#active.delete(id);
      let cleanupFailed = false;
      try {
        await Promise.all([terminateRemoteChild(tunnel), terminateRemoteChild(remoteServer)]);
      } catch {
        cleanupFailed = true;
      }
      const detail = [serverOutput.read(), tunnelOutput.read()].filter(Boolean).join("\n");
      const message =
        error instanceof Error ? error.message : "The remote environment could not be connected.";
      throw new Error(
        [
          message,
          detail,
          cleanupFailed ? "One or more SSH child processes did not confirm shutdown." : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  disconnect(id: string): Promise<void> {
    const existing = this.#disconnecting.get(id);
    if (existing) return existing;
    const pending = this.#disconnect(id).finally(() => {
      if (this.#disconnecting.get(id) === pending) this.#disconnecting.delete(id);
    });
    this.#disconnecting.set(id, pending);
    return pending;
  }

  async #disconnect(id: string): Promise<void> {
    const connecting = this.#connecting.get(id)?.promise;
    await this.#disconnectActive(id);
    if (connecting) {
      await connecting.catch(() => undefined);
      await this.#disconnectActive(id);
    }
  }

  async #disconnectActive(id: string): Promise<void> {
    const active = this.#active.get(id);
    if (!active) return;
    this.#active.delete(id);
    active.cleanup?.();
    await Promise.all([
      terminateRemoteChild(active.tunnel),
      terminateRemoteChild(active.remoteServer),
    ]);
  }

  async #updateRuntime(
    id: string,
    values: Partial<Pick<RemoteEnvironmentRecord, "preferredLocalPort" | "paired">>,
  ): Promise<void> {
    const pending = this.#runtimeMutation.then(() => this.store.updateRuntime(id, values));
    this.#runtimeMutation = pending.catch(() => undefined);
    await pending;
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.store.remove(id);
  }

  async close(): Promise<void> {
    await Promise.all(
      [
        ...new Set([
          ...this.#active.keys(),
          ...this.#connecting.keys(),
          ...this.#disconnecting.keys(),
        ]),
      ].map((id) => this.disconnect(id)),
    );
  }
}
