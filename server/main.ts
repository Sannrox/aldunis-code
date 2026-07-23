import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { createLocalHost, assertLoopbackHost } from "./host.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { defaultStateDirectory } from "./state.ts";

const execFileAsync = promisify(execFile);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const host = argument("--host") ?? "127.0.0.1";
const portValue = argument("--port") ?? "4174";
const port = Number(portValue);
const remoteMode = argument("--remote");
const authAction = argument("--remote-auth");
const publicUrlInput = argument("--public-url");
const tlsCertificatePath = argument("--tls-cert");
const tlsKeyPath = argument("--tls-key");

if (authAction) {
  const auth = new RemoteAuth(defaultStateDirectory());
  if (authAction === "pair") {
    console.log(JSON.stringify(await auth.issuePairing(), null, 2));
  } else if (authAction === "list") {
    console.log(JSON.stringify(await auth.listSessions(), null, 2));
  } else if (authAction === "revoke") {
    const sessionId = argument("--session");
    if (!sessionId) throw new Error("Remote session revocation requires --session <id>.");
    console.log(JSON.stringify({ revoked: await auth.revoke(sessionId) }));
  } else {
    throw new Error("Remote auth action must be 'pair', 'list', or 'revoke'.");
  }
  process.exit(0);
}

function isPrivateAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const [first, second] = value.split(".").map(Number);
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  return isIP(value) === 6 && (value.toLocaleLowerCase().startsWith("fd")
    || value.toLocaleLowerCase().startsWith("fc"));
}

if (!remoteMode) assertLoopbackHost(host);
else if (remoteMode === "lan") {
  if (!isPrivateAddress(host)) {
    throw new Error("LAN remote access requires an explicit private IPv4 or unique-local IPv6 address.");
  }
} else if (remoteMode === "tailscale") {
  assertLoopbackHost(host);
} else {
  throw new Error("Remote mode must be 'lan' or 'tailscale'.");
}
let configuredPublicUrl: string | undefined;
if (remoteMode === "lan") {
  if (!publicUrlInput) {
    throw new Error("LAN remote access requires --public-url with the certificate-matched HTTPS origin.");
  }
  const value = new URL(publicUrlInput);
  if (value.protocol !== "https:" || value.username || value.password || value.hash) {
    throw new Error("The LAN public URL must be an HTTPS origin without credentials or a fragment.");
  }
  configuredPublicUrl = value.origin;
  if (!tlsCertificatePath || !tlsKeyPath) {
    throw new Error("LAN remote access requires --tls-cert and --tls-key PEM files.");
  }
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid port: ${portValue}`);
}

const remoteAuth = remoteMode ? new RemoteAuth(defaultStateDirectory()) : undefined;
const tls = remoteMode === "lan"
  ? {
      cert: await readFile(tlsCertificatePath!),
      key: await readFile(tlsKeyPath!),
    }
  : undefined;
const server = createLocalHost(undefined, undefined, undefined, remoteAuth, tls);
let tailscaleConfigured = false;

async function disableTailscaleServe(): Promise<void> {
  if (!tailscaleConfigured) return;
  tailscaleConfigured = false;
  try {
    await execFileAsync("tailscale", ["serve", "--https=443", "off"]);
  } catch (flaggedError) {
    try {
      await execFileAsync("tailscale", ["serve", "off"]);
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
  server.close(() => process.kill(process.pid, signal));
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

server.listen(port, host, async () => {
  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  const localUrl = `${remoteMode === "lan" ? "https" : "http"}://${formattedHost}:${port}`;
  if (!remoteAuth) {
    console.log(`Aldunis Code is available at ${localUrl}`);
    return;
  }
  let publicUrl = localUrl;
  if (remoteMode === "tailscale") {
    try {
      const before = await execFileAsync("tailscale", ["serve", "status", "--json"]);
      const existing = JSON.parse(before.stdout) as { Web?: Record<string, unknown> };
      if (Object.keys(existing.Web ?? {}).length > 0) {
        throw new Error("Tailscale Serve already has an endpoint; refusing to overwrite it.");
      }
      await execFileAsync("tailscale", ["serve", "--bg", "--https=443", localUrl]);
      tailscaleConfigured = true;
      const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"]);
      const status = JSON.parse(stdout) as { Web?: Record<string, unknown> };
      const endpoint = Object.keys(status.Web ?? {})[0];
      if (!endpoint) throw new Error("Tailscale Serve did not publish an HTTPS endpoint.");
      const endpointUrl = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
      if (endpointUrl.protocol !== "https:") {
        throw new Error("Tailscale Serve published a non-HTTPS endpoint.");
      }
      publicUrl = endpointUrl.origin;
    } catch {
      console.error("Tailscale Serve setup failed. Remote access remains on loopback and fails closed.");
      await disableTailscaleServe();
      server.close();
      process.exitCode = 1;
      return;
    }
  } else {
    publicUrl = configuredPublicUrl!;
    console.warn(`LAN mode is available only through the certificate-matched HTTPS origin ${publicUrl}.`);
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
