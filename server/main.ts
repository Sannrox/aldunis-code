import { isIP } from "node:net";
import packageJson from "../package.json" with { type: "json" };
import { createLocalHost, assertLoopbackHost } from "./host.ts";
import { CliUsageError, formatCliHelp, parseCliArgs, type CliInvocation } from "./cli.ts";
import { loadManagedHostConfiguration, ManagedHost } from "./managed-host.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { defaultStateDirectory, LocalStateStore } from "./state.ts";
import { DEFAULT_HOST_PORT, DEFAULT_SSH_REMOTE_PORT } from "../src/ports.ts";
import { readTlsMaterial } from "./tls-material.ts";
import { runTailscaleCommand } from "./tailscale-command.ts";

let cliInvocation: CliInvocation;
try {
  cliInvocation = parseCliArgs(process.argv.slice(2));
} catch (error) {
  const message =
    error instanceof CliUsageError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`Error: ${message}`);
  console.error(formatCliHelp());
  process.exit(1);
}

if (cliInvocation.kind === "help") {
  console.log(formatCliHelp(cliInvocation.scope));
  process.exit(0);
}
if (cliInvocation.kind === "version") {
  console.log(packageJson.version);
  process.exit(0);
}
if (cliInvocation.kind === "auth") {
  const auth = new RemoteAuth(defaultStateDirectory());
  if (cliInvocation.action === "create") {
    console.log(JSON.stringify(await auth.issuePairing(), null, 2));
  } else if (cliInvocation.action === "list") {
    console.log(JSON.stringify(await auth.listSessions(), null, 2));
  } else {
    console.log(JSON.stringify({ revoked: await auth.revoke(cliInvocation.session!) }));
  }
  process.exit(0);
}

const { options } = cliInvocation;
const host = options.host ?? "127.0.0.1";
const remoteMode = options.remote;
const portValue =
  options.port ?? String(remoteMode === "ssh" ? DEFAULT_SSH_REMOTE_PORT : DEFAULT_HOST_PORT);
const port = Number(portValue);
const publicUrlInput = options.publicUrl;
const tlsCertificatePath = options.tlsCert;
const tlsKeyPath = options.tlsKey;
const configuredHostMode = process.env.ALDUNIS_HOST_MODE;
const managedMode = configuredHostMode === "managed";

if (configuredHostMode && configuredHostMode !== "local" && configuredHostMode !== "managed") {
  throw new Error("ALDUNIS_HOST_MODE must be 'local' or 'managed'.");
}
if (managedMode && remoteMode) {
  throw new Error("Managed hosted mode cannot be combined with paired remote mode.");
}

function isPrivateAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const [first, second] = value.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return (
    isIP(value) === 6 &&
    (value.toLocaleLowerCase().startsWith("fd") || value.toLocaleLowerCase().startsWith("fc"))
  );
}

const loopbackHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
const managedNetworkBind = managedMode && !loopbackHost;

if (!remoteMode && !managedMode) {
  assertLoopbackHost(host);
} else if (managedMode) {
  if (!loopbackHost && !isPrivateAddress(host)) {
    throw new Error(
      "Managed hosted mode requires a loopback or private bind address behind its gateway.",
    );
  }
} else if (remoteMode === "lan") {
  if (!isPrivateAddress(host)) {
    throw new Error(
      "LAN remote access requires an explicit private IPv4 or unique-local IPv6 address.",
    );
  }
} else if (remoteMode === "tailscale" || remoteMode === "ssh") {
  assertLoopbackHost(host);
} else {
  throw new Error("Remote mode must be 'lan', 'tailscale', or 'ssh'.");
}
let configuredPublicUrl: string | undefined;
if (remoteMode === "lan") {
  if (!publicUrlInput) {
    throw new Error(
      "LAN remote access requires --public-url with the certificate-matched HTTPS origin.",
    );
  }
  const value = new URL(publicUrlInput);
  if (value.protocol !== "https:" || value.username || value.password || value.hash) {
    throw new Error(
      "The LAN public URL must be an HTTPS origin without credentials or a fragment.",
    );
  }
  configuredPublicUrl = value.origin;
  if (!tlsCertificatePath || !tlsKeyPath) {
    throw new Error("LAN remote access requires --tls-cert and --tls-key PEM files.");
  }
}
if (managedNetworkBind && (!tlsCertificatePath || !tlsKeyPath)) {
  throw new Error(
    "Managed hosted mode requires --tls-cert and --tls-key PEM files for non-loopback binds.",
  );
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid port: ${portValue}`);
}

const stateDirectory = defaultStateDirectory();
const remoteAuth = remoteMode
  ? new RemoteAuth(stateDirectory, { allowLoopbackHttp: remoteMode === "ssh" })
  : undefined;
const managedHost = managedMode
  ? new ManagedHost(await loadManagedHostConfiguration(), { replayDirectory: stateDirectory })
  : undefined;
const tls =
  remoteMode === "lan" || managedNetworkBind
    ? {
        cert: await readTlsMaterial(tlsCertificatePath!, "TLS certificate"),
        key: await readTlsMaterial(tlsKeyPath!, "TLS private key"),
      }
    : undefined;
let publicUrl = configuredPublicUrl;
const state = new LocalStateStore(stateDirectory);
const releaseWriterLease = await state.acquireWriterLease();
const server = createLocalHost({
  state,
  remoteAuth,
  tls,
  managedHost,
  publicOrigin: remoteMode === "ssh" ? undefined : () => publicUrl,
  localBindHost: host,
  allowLocalControl: remoteMode !== "ssh",
});
let tailscaleConfigured = false;

async function disableTailscaleServe(): Promise<void> {
  if (!tailscaleConfigured) return;
  tailscaleConfigured = false;
  try {
    await runTailscaleCommand(["serve", "--https=443", "off"]);
  } catch (flaggedError) {
    try {
      await runTailscaleCommand(["serve", "off"]);
    } catch (bareError) {
      console.error(
        "Tailscale Serve cleanup failed; run `tailscale serve --https=443 off` locally.",
        { flaggedError, bareError },
      );
    }
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  await disableTailscaleServe();
  server.close((error) => {
    void server
      .closeResources()
      .catch((cleanupError) => {
        console.error("Local services could not be closed cleanly during shutdown.", cleanupError);
      })
      .then(() => releaseWriterLease())
      .catch((leaseError) => {
        console.error("The local-state writer lease could not be released cleanly.", leaseError);
      })
      .finally(() => {
        if (error) console.error("The local host could not close cleanly.", error);
        process.kill(process.pid, signal);
      });
  });
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

server.listen(port, host, async () => {
  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  const localUrl = `${remoteMode === "lan" || managedNetworkBind ? "https" : "http"}://${formattedHost}:${port}`;
  if (managedHost) {
    console.log(`Aldunis Code managed hosted workbench is available at ${localUrl}`);
    return;
  }
  if (!remoteAuth) {
    console.log(`Aldunis Code is available at ${localUrl}`);
    return;
  }
  if (remoteMode === "tailscale") {
    try {
      const before = await runTailscaleCommand(["serve", "status", "--json"]);
      const existing = JSON.parse(before) as { Web?: Record<string, unknown> };
      if (Object.keys(existing.Web ?? {}).length > 0) {
        throw new Error("Tailscale Serve already has an endpoint; refusing to overwrite it.");
      }
      await runTailscaleCommand(["serve", "--bg", "--https=443", localUrl]);
      tailscaleConfigured = true;
      const stdout = await runTailscaleCommand(["serve", "status", "--json"]);
      const status = JSON.parse(stdout) as { Web?: Record<string, unknown> };
      const endpoint = Object.keys(status.Web ?? {})[0];
      if (!endpoint) throw new Error("Tailscale Serve did not publish an HTTPS endpoint.");
      const endpointUrl = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
      if (endpointUrl.protocol !== "https:") {
        throw new Error("Tailscale Serve published a non-HTTPS endpoint.");
      }
      publicUrl = endpointUrl.origin;
    } catch {
      console.error(
        "Tailscale Serve setup failed. Remote access remains on loopback and fails closed.",
      );
      await disableTailscaleServe();
      server.close();
      process.exitCode = 1;
      return;
    }
  } else if (remoteMode === "lan") {
    publicUrl = configuredPublicUrl!;
    console.warn(
      `LAN mode is available only through the certificate-matched HTTPS origin ${publicUrl}.`,
    );
  } else {
    console.log(`SSH remote workbench is available through the loopback forward at ${localUrl}.`);
    return;
  }
  try {
    const pairing = await remoteAuth.issuePairing();
    console.log(`Remote Aldunis Code: ${publicUrl}/#pair=${pairing.credential}`);
    console.log(`Pairing expires at ${pairing.expiresAt}.`);
  } catch {
    console.error("Remote pairing initialization failed. Remote access was disabled.");
    await disableTailscaleServe();
    server.close();
    process.exitCode = 1;
  }
});
