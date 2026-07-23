interface RemoteSession {
  hostId: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

const STORAGE_KEY = "aldunis-code.remote-session.v1";
const KEY_DATABASE = "aldunis-code-remote-auth";
const KEY_STORE = "device-keys";
const nativeFetch = window.fetch.bind(window);

function encode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function sha256(value: BufferSource): Promise<string> {
  return encode(await crypto.subtle.digest("SHA-256", value));
}

function loadSession(): RemoteSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as RemoteSession | null;
    return value && Date.parse(value.expiresAt) > Date.now() ? value : null;
  } catch {
    return null;
  }
}

function keyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Remote device key storage is unavailable."));
  });
}

async function storePrivateKey(hostId: string, key: CryptoKey): Promise<void> {
  const database = await keyDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(KEY_STORE, "readwrite");
    transaction.objectStore(KEY_STORE).put(key, hostId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("The remote device key could not be stored."));
  });
  database.close();
}

async function loadPrivateKey(hostId: string): Promise<CryptoKey | null> {
  const database = await keyDatabase();
  const result = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const request = database.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(hostId);
    request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
    request.onerror = () => reject(new Error("The remote device key could not be read."));
  });
  database.close();
  return result ?? null;
}

async function pairFromFragment(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const credential = params.get("pair");
  if (!credential) return;
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const response = await nativeFetch("/api/remote/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential,
      label: `${navigator.platform || "Browser"} · ${navigator.userAgent.includes("Mobile") ? "mobile" : "browser"}`,
      publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey),
    }),
  });
  const body = await response.json() as Omit<RemoteSession, "privateKey"> & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Remote pairing failed.");
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const nonExportablePrivateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  await storePrivateKey(body.hostId, nonExportablePrivateKey);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(body));
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

async function authorizedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url, location.href);
  if (
    url.origin !== location.origin
    || !url.pathname.startsWith("/api/")
    || url.pathname === "/api/remote/pair"
  ) {
    return nativeFetch(request);
  }
  const session = loadSession();
  if (!session) return nativeFetch(request);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD"
    ? new ArrayBuffer(0)
    : await request.clone().arrayBuffer();
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const payload = [
    method,
    location.origin,
    url.pathname,
    timestamp,
    nonce,
    await sha256(body),
  ].join("\n");
  const privateKey = await loadPrivateKey(session.hostId);
  if (!privateKey) throw new Error("The remote device key is missing. Pair this device again.");
  const signature = encode(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload),
  ));
  const headers = new Headers(request.headers);
  headers.set("authorization", `DPoP ${session.sessionId}.${session.sessionToken}`);
  headers.set("x-aldunis-timestamp", timestamp);
  headers.set("x-aldunis-nonce", nonce);
  headers.set("x-aldunis-signature", signature);
  headers.set("x-aldunis-origin", location.origin);
  const response = await nativeFetch(new Request(request, { headers }));
  if (response.status === 401) {
    localStorage.removeItem(STORAGE_KEY);
    queueMicrotask(() => location.reload());
  }
  return response;
}

export async function initializeRemoteAuthentication(): Promise<void> {
  await pairFromFragment();
  const descriptorResponse = await nativeFetch("/api/remote/descriptor", { method: "POST" });
  if (descriptorResponse.ok) {
    const descriptor = await descriptorResponse.json() as { protocolVersion?: unknown };
    if (descriptor.protocolVersion !== 1) {
      throw new Error("This Aldunis host uses an incompatible remote protocol.");
    }
    if (!loadSession()) {
      throw new Error("This device is not paired, or its session expired or was revoked. Create a new pairing link on the host.");
    }
  }
  window.fetch = authorizedFetch;
}
