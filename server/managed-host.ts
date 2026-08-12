import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  canonicalizeDiscoveredWorktreePaths,
  canonicalizeRepositoryRoot,
  discoverWorktrees,
  RepositoryError,
} from "./repository.ts";

const ASSERTION_HEADER = "x-aldunis-code-assertion";
const REQUIRED_SCOPE = "code:workbench";
const MAX_ASSERTION_TTL_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;
const MAX_REPLAY_ENTRIES = 10_000;
const DEFAULT_MANAGED_DISPLAY_NAME = "Enterprise user";
const RESERVED_MANAGED_RUNTIME_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "ELECTRON_RUN_AS_NODE",
  "SHIKIGAMI_CONFIG",
  "SHIKIGAMI_STATE",
]);

export interface ManagedRepository {
  id: string;
  name: string;
  root: string;
  device: number;
  inode: number;
}

export interface ManagedShikigamiRuntime {
  executable: string;
  model: string;
  governanceEndpoint: string;
  principal: string;
  namespace: string;
  tokenEnv: string;
  token: string;
  path?: string;
  /** Dedicated state root selected by the Code host, never a customer worktree. */
  stateRoot?: string;
}

export interface ManagedHostConfiguration {
  issuer: string;
  audience: string;
  tenantId: string;
  instanceId: string;
  publicKey: KeyObject;
  logoutUrl?: string | null;
  repositories: ManagedRepository[];
  shikigami: ManagedShikigamiRuntime;
}

export interface ManagedIdentity {
  subject: string;
  displayName: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
  assertionExpiresAt: string;
  sessionExpiresAt: string | null;
  logoutUrl: string | null;
}

interface ManagedAssertionHeader {
  alg?: unknown;
  typ?: unknown;
  kid?: unknown;
}

interface ManagedAssertionClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  jti?: unknown;
  tenant_id?: unknown;
  instance_id?: unknown;
  name?: unknown;
  display_name?: unknown;
  preferred_username?: unknown;
  email?: unknown;
  role?: unknown;
  roles?: unknown;
  scope?: unknown;
  scopes?: unknown;
  session_exp?: unknown;
  code_mode?: unknown;
  managed_profile?: unknown;
  method?: unknown;
  path?: unknown;
  body_sha256?: unknown;
}

export class ManagedHostError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ManagedHostError(`${name} is required for managed hosted mode.`, 500);
  }
  return value.trim();
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ManagedHostError(`Managed assertion ${label} is malformed.`);
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new ManagedHostError(`Managed assertion ${label} is malformed.`);
  }
}

function decodeJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(decodeBase64Url(value, label).toString("utf8")) as T;
  } catch {
    throw new ManagedHostError(`Managed assertion ${label} is malformed.`);
  }
}

function stringClaim(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ManagedHostError(`Managed assertion is missing ${name}.`);
  }
  return value;
}

function numericClaim(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ManagedHostError(`Managed assertion is missing ${name}.`);
  }
  return value;
}

function optionalClaimString(value: unknown, name: string, maxLength = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = stringClaim(value, name).trim();
  if (result.length > maxLength) {
    throw new ManagedHostError(`Managed assertion ${name} is too long.`);
  }
  return result;
}

function claimList(value: unknown, name: string, splitString = true, maxItems = 20): string[] {
  if (value === undefined || value === null) return [];
  const values =
    typeof value === "string"
      ? splitString
        ? value.split(/[\s,]+/)
        : [value]
      : Array.isArray(value) && value.every((item) => typeof item === "string")
        ? (value as string[])
        : null;
  if (!values) throw new ManagedHostError(`Managed assertion ${name} is malformed.`);
  const result = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  if (result.length > maxItems || result.some((item) => item.length > 100)) {
    throw new ManagedHostError(`Managed assertion ${name} is too long.`);
  }
  return result;
}

function assertionScopes(claims: ManagedAssertionClaims): string[] {
  const value = claims.scope ?? claims.scopes;
  return claimList(value, "scope");
}

function assertionRoles(claims: ManagedAssertionClaims): string[] {
  return claimList(claims.roles ?? claims.role, "roles");
}

function managedLogoutUrl(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ManagedHostError("ALDUNIS_MANAGED_LOGOUT_URL must be an HTTPS URL.", 500);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ManagedHostError("ALDUNIS_MANAGED_LOGOUT_URL must be an HTTPS URL.", 500);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new ManagedHostError(
      "ALDUNIS_MANAGED_LOGOUT_URL must be an HTTPS URL without credentials or a fragment.",
      500,
    );
  }
  return parsed.toString();
}

function bodyDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("base64url");
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function parseRepositoryCatalogue(raw: string): Array<{ id: string; name: string; root: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManagedHostError("ALDUNIS_MANAGED_REPOSITORIES_JSON must be valid JSON.", 500);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ManagedHostError(
      "Managed hosted mode requires a non-empty repository catalogue.",
      500,
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ManagedHostError(
        `Managed repository catalogue entry ${index + 1} is invalid.`,
        500,
      );
    }
    const record = entry as Record<string, unknown>;
    const id = nonEmpty(record.id, `Managed repository catalogue entry ${index + 1} id`);
    const name = nonEmpty(record.name, `Managed repository ${id} name`);
    const root = nonEmpty(record.root, `Managed repository ${id} root`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) {
      throw new ManagedHostError(`Managed repository id ${id} is invalid.`, 500);
    }
    if (!isAbsolute(root)) {
      throw new ManagedHostError(`Managed repository ${id} root must be absolute.`, 500);
    }
    return { id, name, root };
  });
}

async function readPublicKey(env: NodeJS.ProcessEnv): Promise<KeyObject> {
  const inline = env.ALDUNIS_MANAGED_ASSERTION_PUBLIC_KEY_PEM?.trim();
  const file = env.ALDUNIS_MANAGED_ASSERTION_PUBLIC_KEY_FILE?.trim();
  if (Boolean(inline) === Boolean(file)) {
    throw new ManagedHostError(
      "Managed hosted mode requires exactly one assertion public key PEM or file.",
      500,
    );
  }
  try {
    const pem = inline ?? (await readFile(file!, "utf8"));
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("Managed assertions require an Ed25519 public key.");
    }
    return key;
  } catch {
    throw new ManagedHostError("Managed assertion public key is invalid or unreadable.", 500);
  }
}

async function canonicalRepositories(raw: string): Promise<ManagedRepository[]> {
  const entries = parseRepositoryCatalogue(raw);
  const ids = new Set<string>();
  const roots = new Set<string>();
  const result: ManagedRepository[] = [];
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new ManagedHostError(`Managed repository id ${entry.id} is duplicated.`, 500);
    }
    ids.add(entry.id);
    const root = await canonicalizeRepositoryRoot(entry.root);
    if (roots.has(root)) {
      throw new ManagedHostError(`Managed repository root ${root} is duplicated.`, 500);
    }
    roots.add(root);
    const details = await stat(root);
    if (details.dev === undefined || details.ino === undefined) {
      throw new ManagedHostError(`Managed repository ${entry.id} has no filesystem identity.`, 500);
    }
    result.push({ id: entry.id, name: entry.name, root, device: details.dev, inode: details.ino });
  }
  return result;
}

export async function loadManagedHostConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedHostConfiguration> {
  const issuer = nonEmpty(env.ALDUNIS_MANAGED_ASSERTION_ISSUER, "ALDUNIS_MANAGED_ASSERTION_ISSUER");
  const audience = nonEmpty(
    env.ALDUNIS_MANAGED_ASSERTION_AUDIENCE,
    "ALDUNIS_MANAGED_ASSERTION_AUDIENCE",
  );
  const tenantId = nonEmpty(env.ALDUNIS_MANAGED_TENANT_ID, "ALDUNIS_MANAGED_TENANT_ID");
  const instanceId = nonEmpty(env.ALDUNIS_MANAGED_INSTANCE_ID, "ALDUNIS_MANAGED_INSTANCE_ID");
  const logoutUrl = managedLogoutUrl(env.ALDUNIS_MANAGED_LOGOUT_URL);
  const repositoriesJson = nonEmpty(
    env.ALDUNIS_MANAGED_REPOSITORIES_JSON,
    "ALDUNIS_MANAGED_REPOSITORIES_JSON",
  );
  const executable = nonEmpty(
    env.ALDUNIS_MANAGED_SHIKIGAMI_EXECUTABLE,
    "ALDUNIS_MANAGED_SHIKIGAMI_EXECUTABLE",
  );
  const model = nonEmpty(env.ALDUNIS_MANAGED_SHIKIGAMI_MODEL, "ALDUNIS_MANAGED_SHIKIGAMI_MODEL");
  const governanceEndpoint = nonEmpty(
    env.ALDUNIS_MANAGED_SHIKIGAMI_GOVERNANCE_ENDPOINT,
    "ALDUNIS_MANAGED_SHIKIGAMI_GOVERNANCE_ENDPOINT",
  );
  const principal = nonEmpty(
    env.ALDUNIS_MANAGED_SHIKIGAMI_PRINCIPAL,
    "ALDUNIS_MANAGED_SHIKIGAMI_PRINCIPAL",
  );
  const namespace = nonEmpty(
    env.ALDUNIS_MANAGED_SHIKIGAMI_NAMESPACE,
    "ALDUNIS_MANAGED_SHIKIGAMI_NAMESPACE",
  );
  const tokenEnv = nonEmpty(
    env.ALDUNIS_MANAGED_SHIKIGAMI_TOKEN_ENV ?? "SEKAI_TOKEN",
    "ALDUNIS_MANAGED_SHIKIGAMI_TOKEN_ENV",
  );
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv)) {
    throw new ManagedHostError("Managed Shikigami token environment name is invalid.", 500);
  }
  if (RESERVED_MANAGED_RUNTIME_ENVIRONMENT_KEYS.has(tokenEnv)) {
    throw new ManagedHostError(
      "Managed Shikigami token environment name collides with a reserved runtime key.",
      500,
    );
  }
  const token = nonEmpty(env[tokenEnv], tokenEnv);
  const path = env.ALDUNIS_MANAGED_SHIKIGAMI_PATH?.trim();
  if (!path && !isAbsolute(executable)) {
    throw new ManagedHostError(
      "Managed Shikigami requires an absolute executable or an explicit PATH allowlist.",
      500,
    );
  }
  return {
    issuer,
    audience,
    tenantId,
    instanceId,
    publicKey: await readPublicKey(env),
    logoutUrl,
    repositories: await canonicalRepositories(repositoriesJson),
    shikigami: {
      executable,
      model,
      governanceEndpoint,
      principal,
      namespace,
      tokenEnv,
      token,
      ...(path ? { path } : {}),
    },
  };
}

export class ManagedHost {
  readonly #replayed = new Map<string, number>();
  readonly #repositoriesById: ReadonlyMap<string, ManagedRepository>;
  readonly #repositoriesByRoot: ReadonlyMap<string, ManagedRepository>;
  readonly #now: () => number;

  constructor(
    readonly configuration: ManagedHostConfiguration,
    now: () => number = () => Date.now(),
  ) {
    this.#now = now;
    this.#repositoriesById = new Map(configuration.repositories.map((repo) => [repo.id, repo]));
    this.#repositoriesByRoot = new Map(configuration.repositories.map((repo) => [repo.root, repo]));
  }

  get shikigami(): ManagedShikigamiRuntime {
    return this.configuration.shikigami;
  }

  capabilities(identity?: ManagedIdentity): Record<string, unknown> {
    return {
      mode: "managed",
      managed: true,
      tenantScoped: true,
      singleTenantAlpha: true,
      account: identity
        ? {
            displayName: identity.displayName,
            tenantId: identity.tenantId,
            roles: identity.roles,
            scopes: identity.scopes,
            assertionExpiresAt: identity.assertionExpiresAt,
            sessionExpiresAt: identity.sessionExpiresAt,
            logoutUrl: identity.logoutUrl,
          }
        : null,
      provider: {
        id: "shikigami",
        name: "Shikigami",
        execution: "Build",
        model: this.shikigami.model,
        modelAdapter: "plane",
        governanceAdapter: "sekai-chisei",
      },
      capabilities: {
        providerSelection: false,
        profileAdministration: false,
        adapterAdministration: false,
        modelSelection: false,
        modeSelection: false,
        arbitraryRepositorySelection: false,
        directoryBrowsing: false,
      },
      repositories: this.configuration.repositories.map(({ id, name }) => ({ id, name })),
      state: {
        policy: "dedicated-volume-no-backup",
        restart: "preserve-volume",
        loss: "visible-and-fail-closed",
      },
    };
  }

  repository(id: string): ManagedRepository {
    const repository = this.#repositoriesById.get(id);
    if (!repository)
      throw new RepositoryError("The requested repository is not in the managed catalogue.", 403);
    return repository;
  }

  repositoryForRoot(root: string): ManagedRepository {
    const repository = this.#repositoriesByRoot.get(root);
    if (!repository)
      throw new RepositoryError("The repository is not in the managed catalogue.", 403);
    return repository;
  }

  async verifyRepository(repository: ManagedRepository): Promise<void> {
    try {
      const details = await stat(repository.root);
      if (details.dev !== repository.device || details.ino !== repository.inode) {
        throw new RepositoryError(
          "The managed repository filesystem identity changed; restart the host after re-provisioning it.",
          403,
        );
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("The managed repository is unavailable.", 403);
    }
  }

  async verifyRepositoryRoot(root: string): Promise<void> {
    const repository = this.repositoryForRoot(root);
    await this.verifyRepository(repository);
  }

  async selectWorktree(
    rootInput: string,
    worktreeInput: string,
  ): Promise<{ root: string; worktree: string; repositoryId: string }> {
    if (!isAbsolute(rootInput) || !isAbsolute(worktreeInput)) {
      throw new RepositoryError(
        "Managed requests require absolute canonical repository paths.",
        403,
      );
    }
    try {
      if (
        (await lstat(rootInput)).isSymbolicLink() ||
        (await lstat(worktreeInput)).isSymbolicLink()
      ) {
        throw new RepositoryError("Managed repository and worktree symlinks are not allowed.", 403);
      }
      const root = await realpath(rootInput);
      const repository = this.repositoryForRoot(root);
      await this.verifyRepository(repository);
      const worktree = await realpath(worktreeInput);
      const worktreeDetails = await stat(worktree);
      const rootDetails = await stat(root);
      if (worktreeDetails.dev !== rootDetails.dev) {
        throw new RepositoryError("Managed worktrees cannot cross filesystem mounts.", 403);
      }
      const worktrees = await discoverWorktrees(root);
      const allowed = await canonicalizeDiscoveredWorktreePaths(worktrees);
      if (!allowed.has(worktree)) {
        throw new RepositoryError("Select a discovered worktree from the managed repository.", 403);
      }
      return { root, worktree, repositoryId: repository.id };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("The managed repository or worktree is unavailable.", 403);
    }
  }

  async verify(request: IncomingMessage, body: Buffer): Promise<ManagedIdentity> {
    const raw = request.headers[ASSERTION_HEADER];
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ManagedHostError("A gateway-issued managed assertion is required.");
    }
    const parts = raw.trim().split(".");
    if (parts.length !== 3) throw new ManagedHostError("Managed assertion is malformed.");
    const header = decodeJson<ManagedAssertionHeader>(parts[0], "header");
    const claims = decodeJson<ManagedAssertionClaims>(parts[1], "claims");
    if (header.alg !== "EdDSA")
      throw new ManagedHostError("Managed assertion algorithm is not allowed.");
    const signature = decodeBase64Url(parts[2], "signature");
    if (
      !verifySignature(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
        this.configuration.publicKey,
        signature,
      )
    ) {
      throw new ManagedHostError("Managed assertion signature is invalid.");
    }
    if (claims.iss !== this.configuration.issuer || claims.aud !== this.configuration.audience) {
      throw new ManagedHostError("Managed assertion issuer or audience is not trusted.");
    }
    if (
      claims.tenant_id !== this.configuration.tenantId ||
      claims.instance_id !== this.configuration.instanceId
    ) {
      throw new ManagedHostError("Managed assertion tenant or instance is not trusted.");
    }
    if (claims.code_mode !== "managed" || claims.managed_profile !== "aldunis-code-managed") {
      throw new ManagedHostError("Managed assertion does not authorize the hosted workbench.");
    }
    const scopes = assertionScopes(claims);
    if (!scopes.includes(REQUIRED_SCOPE)) {
      throw new ManagedHostError("Managed assertion does not include the Code workbench scope.");
    }
    const now = Math.floor(this.#now() / 1000);
    const subject = stringClaim(claims.sub, "sub");
    const roles = assertionRoles(claims);
    const exp = numericClaim(claims.exp, "exp");
    const iat = numericClaim(claims.iat, "iat");
    if (exp <= now - CLOCK_SKEW_SECONDS || iat > now + CLOCK_SKEW_SECONDS) {
      throw new ManagedHostError("Managed assertion is expired or not yet valid.");
    }
    if (exp <= iat || exp - iat > MAX_ASSERTION_TTL_SECONDS) {
      throw new ManagedHostError("Managed assertion lifetime is not allowed.");
    }
    const sessionExp =
      claims.session_exp === undefined ? null : numericClaim(claims.session_exp, "session_exp");
    if (sessionExp !== null && sessionExp <= now - CLOCK_SKEW_SECONDS) {
      throw new ManagedHostError("Managed account session is expired.");
    }
    if (sessionExp !== null && sessionExp < iat) {
      throw new ManagedHostError("Managed account session expiry is invalid.");
    }
    if (claims.nbf !== undefined && numericClaim(claims.nbf, "nbf") > now + CLOCK_SKEW_SECONDS) {
      throw new ManagedHostError("Managed assertion is not yet valid.");
    }
    const jti = stringClaim(claims.jti, "jti");
    if (jti.length > 200) throw new ManagedHostError("Managed assertion identity is too long.");
    for (const [key, expiresAt] of this.#replayed) {
      if (expiresAt <= now) this.#replayed.delete(key);
    }
    if (this.#replayed.has(jti))
      throw new ManagedHostError("Managed assertion was already used.", 401);
    if (this.#replayed.size >= MAX_REPLAY_ENTRIES) {
      throw new ManagedHostError("Managed assertion replay protection is at capacity.", 503);
    }
    const expectedMethod = claims.method;
    if (expectedMethod !== undefined && expectedMethod !== request.method) {
      throw new ManagedHostError("Managed assertion method binding does not match the request.");
    }
    const expectedPath = claims.path;
    if (expectedPath !== undefined && expectedPath !== requestPath(request)) {
      throw new ManagedHostError("Managed assertion path binding does not match the request.");
    }
    const expectedBody = claims.body_sha256;
    if (expectedBody !== undefined && expectedBody !== bodyDigest(body)) {
      throw new ManagedHostError("Managed assertion body binding does not match the request.");
    }
    this.#replayed.set(jti, exp + CLOCK_SKEW_SECONDS);
    const displayName =
      optionalClaimString(claims.name, "name") ??
      optionalClaimString(claims.display_name, "display_name") ??
      optionalClaimString(claims.preferred_username, "preferred_username") ??
      optionalClaimString(claims.email, "email") ??
      DEFAULT_MANAGED_DISPLAY_NAME;
    return {
      subject,
      displayName,
      tenantId: this.configuration.tenantId,
      roles,
      scopes,
      assertionExpiresAt: new Date(exp * 1000).toISOString(),
      sessionExpiresAt: sessionExp === null ? null : new Date(sessionExp * 1000).toISOString(),
      logoutUrl: this.configuration.logoutUrl ?? null,
    };
  }
}

export const managedAssertionHeader = ASSERTION_HEADER;
export const managedAssertionRequiredScope = REQUIRED_SCOPE;
