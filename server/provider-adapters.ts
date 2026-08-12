import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, opendir, readFile, rename, rm, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { lock } from "proper-lockfile";

export const ADAPTER_SCHEMA_VERSION = 1;
export const ACP_PROTOCOL_VERSION = 1;
export const MAX_DURABLE_PROVIDER_ADAPTERS = 64;
export const MAX_PROVIDER_ADAPTER_DIRECTORY_ENTRIES = 256;
const ALDUNIS_VERSION = "0.1.0";
const MAX_MANIFEST_BYTES = 64 * 1024;
const ADAPTER_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const GENERIC_INTERPRETERS =
  /^(?:(?:ba|z|c|k|fi)?sh|fish|node(?:js)?|deno|bun|python(?:\d+(?:\.\d+)*)?|pypy(?:\d+)?|ruby|perl|php|java|jshell|lua|luajit|tclsh|wish|rscript|busybox|cmd|powershell|pwsh|env|git|npm|npx|pnpm|yarn|make|cmake|cargo|go|docker|podman|ssh|curl|wget|xargs|find|awk|sed)(?:\.exe)?$/i;
const SAFE_FIXED_OPTION = /^--?[A-Za-z][A-Za-z0-9-]*$/;

export interface ProviderAdapterManifest {
  schemaVersion: 1;
  id: string;
  publisher: { name: string };
  version: string;
  aldunis: { minimumVersion: string; maximumVersion: string };
  protocol: { kind: "acp"; minimumVersion: 1; maximumVersion: 1 };
  executable: { names: string[]; arguments: string[] };
  capabilities: {
    tools: boolean;
    images: boolean;
    /** Optional for schema-v1 installs created before this capability existed. */
    browserObservation?: boolean;
    /** Optional until an ACP adapter has an explicitly reviewed MCP contract. */
    browserAutomation?: boolean;
    sessionResume: boolean;
  };
  environment: Array<{ name: string; required: boolean; sensitive: boolean }>;
  presentation: { name: string; description: string; website?: string };
}

export interface InstalledProviderAdapter {
  schemaVersion: 1;
  source: string;
  digest: string;
  enabled: boolean;
  installedAt: string;
  manifest: ProviderAdapterManifest;
}

interface AdapterRecord {
  schemaVersion: 1;
  current: InstalledProviderAdapter;
  previous: InstalledProviderAdapter | null;
}

export class ProviderAdapterError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderAdapterError(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: string[], context: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new ProviderAdapterError(`${context} contains unknown field ${unknown}.`);
}

function string(value: unknown, context: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new ProviderAdapterError(`${context} must be a non-empty bounded string.`);
  }
  return value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new ProviderAdapterError(`${context} must be a boolean.`);
  return value;
}

function version(value: unknown, context: string): string {
  const result = string(value, context, 64);
  const match = result.match(VERSION);
  if (
    !match ||
    (match[4]
      ?.split(".")
      .some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")) ??
      false)
  ) {
    throw new ProviderAdapterError(`${context} must be a semantic version.`);
  }
  return result;
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => {
    const match = value.match(VERSION);
    if (!match) throw new ProviderAdapterError("Version comparison requires semantic versions.");
    return {
      core: [match[1], match[2], match[3]],
      prerelease: match[4]?.split(".") ?? [],
    };
  };
  const compareNumeric = (leftValue: string, rightValue: string): number => {
    if (leftValue.length !== rightValue.length) return leftValue.length - rightValue.length;
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumeric(a.core[index], b.core[index]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function stringArray(value: unknown, context: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new ProviderAdapterError(`${context} must contain between 1 and ${maximum} values.`);
  }
  return value.map((entry, index) => string(entry, `${context}[${index}]`, 512));
}

export function parseProviderAdapterManifest(value: unknown): ProviderAdapterManifest {
  const manifest = record(value, "Adapter manifest");
  exact(
    manifest,
    [
      "schemaVersion",
      "id",
      "publisher",
      "version",
      "aldunis",
      "protocol",
      "executable",
      "capabilities",
      "environment",
      "presentation",
    ],
    "Adapter manifest",
  );
  if (manifest.schemaVersion !== ADAPTER_SCHEMA_VERSION) {
    throw new ProviderAdapterError("Adapter manifest schema version is unsupported.");
  }
  const id = string(manifest.id, "Adapter ID", 64);
  if (!ADAPTER_ID.test(id) || id.includes("..")) {
    throw new ProviderAdapterError("Adapter ID must be a stable lowercase dotted identifier.");
  }
  const publisher = record(manifest.publisher, "Publisher");
  exact(publisher, ["name"], "Publisher");
  const aldunis = record(manifest.aldunis, "Aldunis compatibility");
  exact(aldunis, ["minimumVersion", "maximumVersion"], "Aldunis compatibility");
  const minimumVersion = version(aldunis.minimumVersion, "Minimum Aldunis version");
  const maximumVersion = version(aldunis.maximumVersion, "Maximum Aldunis version");
  if (
    compareVersions(minimumVersion, maximumVersion) > 0 ||
    compareVersions(ALDUNIS_VERSION, minimumVersion) < 0 ||
    compareVersions(ALDUNIS_VERSION, maximumVersion) > 0
  ) {
    throw new ProviderAdapterError(
      `Adapter is incompatible with Aldunis Code ${ALDUNIS_VERSION}.`,
      409,
    );
  }
  const protocol = record(manifest.protocol, "Protocol");
  exact(protocol, ["kind", "minimumVersion", "maximumVersion"], "Protocol");
  if (
    protocol.kind !== "acp" ||
    protocol.minimumVersion !== ACP_PROTOCOL_VERSION ||
    protocol.maximumVersion !== ACP_PROTOCOL_VERSION
  ) {
    throw new ProviderAdapterError("Adapter requires an unsupported protocol.", 409);
  }
  const executable = record(manifest.executable, "Executable");
  exact(executable, ["names", "arguments"], "Executable");
  const names = stringArray(executable.names, "Executable names", 8);
  for (const name of names) {
    if (isAbsolute(name) || name !== parse(name).base || name === "." || name === "..") {
      throw new ProviderAdapterError("Executable discovery rules may contain file names only.");
    }
    if (GENERIC_INTERPRETERS.test(name)) {
      throw new ProviderAdapterError(
        "Executable discovery cannot target a generic interpreter or shell.",
      );
    }
  }
  const argumentsValue = Array.isArray(executable.arguments) ? executable.arguments : null;
  if (!argumentsValue || argumentsValue.length > 32) {
    throw new ProviderAdapterError("Executable arguments must be a bounded array.");
  }
  const reviewedKiroLaunch =
    names.length === 2 &&
    names[0] === "kiro-cli" &&
    names[1] === "kiro-cli.exe" &&
    argumentsValue.length === 1 &&
    argumentsValue[0] === "acp";
  // OpenCode's ACP entrypoint is the fixed subcommand `acp` (docs: opencode acp).
  // Only this exact reviewed launch is accepted — not free-form positionals.
  const reviewedOpenCodeLaunch =
    names.length === 2 &&
    names[0] === "opencode" &&
    names[1] === "opencode.exe" &&
    argumentsValue.length === 1 &&
    argumentsValue[0] === "acp";
  // Grok Build's ACP entrypoint is the fixed subcommand path `agent stdio`,
  // not a free-form option flag. Only this exact reviewed launch is accepted.
  const reviewedGrokLaunch =
    names.length === 2 &&
    names[0] === "grok" &&
    names[1] === "grok.exe" &&
    argumentsValue.length === 2 &&
    argumentsValue[0] === "agent" &&
    argumentsValue[1] === "stdio";
  const argumentsList = argumentsValue.map((entry, index) => {
    const argument = string(entry, `Executable arguments[${index}]`, 512);
    if (
      !reviewedKiroLaunch &&
      !reviewedOpenCodeLaunch &&
      !reviewedGrokLaunch &&
      !SAFE_FIXED_OPTION.test(argument)
    ) {
      throw new ProviderAdapterError(
        "Version 1 executable arguments may contain option flags only.",
      );
    }
    return argument;
  });
  const capabilities = record(manifest.capabilities, "Capabilities");
  exact(
    capabilities,
    ["tools", "images", "browserObservation", "browserAutomation", "sessionResume"],
    "Capabilities",
  );
  if (capabilities.sessionResume !== true) {
    throw new ProviderAdapterError(
      "Version 1 adapters must support resumable multi-turn sessions.",
    );
  }
  if (capabilities.images !== false) {
    throw new ProviderAdapterError("Version 1 adapters do not support normalized image content.");
  }
  if (!Array.isArray(manifest.environment) || manifest.environment.length > 32) {
    throw new ProviderAdapterError("Environment references must be a bounded array.");
  }
  const environment = manifest.environment.map((entry, index) => {
    const reference = record(entry, `Environment reference ${index}`);
    exact(reference, ["name", "required", "sensitive"], `Environment reference ${index}`);
    const name = string(reference.name, `Environment reference ${index} name`, 128);
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new ProviderAdapterError(`Environment reference ${index} has an invalid name.`);
    }
    return {
      name,
      required: boolean(reference.required, `Environment reference ${index} required`),
      sensitive: boolean(reference.sensitive, `Environment reference ${index} sensitive`),
    };
  });
  if (new Set(environment.map(({ name }) => name)).size !== environment.length) {
    throw new ProviderAdapterError("Environment reference names must be unique.");
  }
  const presentation = record(manifest.presentation, "Presentation");
  exact(presentation, ["name", "description", "website"], "Presentation");
  const website =
    presentation.website === undefined
      ? undefined
      : string(presentation.website, "Presentation website", 512);
  if (website !== undefined) {
    let url: URL;
    try {
      url = new URL(website);
    } catch {
      throw new ProviderAdapterError("Presentation website must be a valid HTTPS URL.");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new ProviderAdapterError(
        "Presentation website must be an HTTPS URL without credentials.",
      );
    }
  }
  return {
    schemaVersion: 1,
    id,
    publisher: { name: string(publisher.name, "Publisher name") },
    version: version(manifest.version, "Adapter version"),
    aldunis: { minimumVersion, maximumVersion },
    protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
    executable: { names, arguments: argumentsList },
    capabilities: {
      tools: boolean(capabilities.tools, "Tools capability"),
      images: boolean(capabilities.images, "Images capability"),
      ...(capabilities.browserObservation === undefined
        ? {}
        : {
            browserObservation: boolean(
              capabilities.browserObservation,
              "Browser observation capability",
            ),
          }),
      ...(capabilities.browserAutomation === undefined
        ? {}
        : {
            browserAutomation: boolean(
              capabilities.browserAutomation,
              "Browser automation capability",
            ),
          }),
      sessionResume: boolean(capabilities.sessionResume, "Session resume capability"),
    },
    environment,
    presentation: {
      name: string(presentation.name, "Presentation name"),
      description: string(presentation.description, "Presentation description", 1024),
      ...(website === undefined ? {} : { website }),
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function adapterDigest(manifest: ProviderAdapterManifest): string {
  return `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}`;
}

export function adapterReference(manifest: ProviderAdapterManifest): string {
  return `adapter:${manifest.id}@${manifest.version}`;
}

function safeId(id: string): string {
  if (!ADAPTER_ID.test(id) || id.includes(".."))
    throw new ProviderAdapterError("Invalid adapter ID.");
  return id;
}

export class ProviderAdapterStore {
  readonly #directory: string;
  readonly #inventoryLockPath: string;
  readonly #mutations = new Map<string, Promise<void>>();
  #inventoryQueue: Promise<void> = Promise.resolve();

  constructor(
    stateDirectory: string,
    readonly maxAdapters = MAX_DURABLE_PROVIDER_ADAPTERS,
    readonly maxDirectoryEntries = MAX_PROVIDER_ADAPTER_DIRECTORY_ENTRIES,
  ) {
    this.#directory = join(stateDirectory, "provider-adapters");
    this.#inventoryLockPath = join(stateDirectory, "provider-adapter-inventory");
  }

  async list(): Promise<InstalledProviderAdapter[]> {
    const installed = await this.#installedAdapters();
    return installed.sort((left, right) =>
      left.manifest.presentation.name.localeCompare(right.manifest.presentation.name),
    );
  }

  async get(id: string): Promise<AdapterRecord | null> {
    try {
      return await this.#read(safeId(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async version(reference: string): Promise<InstalledProviderAdapter | null> {
    const match = reference.match(/^adapter:([a-z0-9.-]+)@(.+)$/);
    if (!match) return null;
    const record = await this.get(match[1]);
    if (!record) return null;
    return (
      [record.current, record.previous].find(
        (candidate) => candidate?.manifest.version === match[2],
      ) ?? null
    );
  }

  inspect(input: {
    source: unknown;
    digest: unknown;
    manifest: unknown;
  }): InstalledProviderAdapter {
    const source = string(input.source, "Adapter source", 2048);
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(source);
    } catch {
      throw new ProviderAdapterError("Adapter source must be a valid HTTPS or local file URL.");
    }
    if (
      (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "file:") ||
      sourceUrl.username ||
      sourceUrl.password ||
      sourceUrl.search ||
      sourceUrl.hash
    ) {
      throw new ProviderAdapterError("Adapter source must be an HTTPS or local file URL.");
    }
    const manifest = parseProviderAdapterManifest(input.manifest);
    const digest = adapterDigest(manifest);
    if (input.digest !== digest)
      throw new ProviderAdapterError("Adapter digest does not match the reviewed manifest.");
    return {
      schemaVersion: 1,
      source,
      digest,
      enabled: true,
      installedAt: new Date().toISOString(),
      manifest,
    };
  }

  async install(input: {
    source: unknown;
    digest: unknown;
    manifest: unknown;
  }): Promise<InstalledProviderAdapter> {
    const candidate = this.inspect(input);
    return this.#serializeInventory(async () => {
      return this.#serialize(candidate.manifest.id, async () => {
        const existing = await this.get(candidate.manifest.id);
        if (existing)
          throw new ProviderAdapterError("An adapter with this ID is already installed.", 409);
        if ((await this.#installedAdapters()).length >= this.maxAdapters) {
          throw new ProviderAdapterError("The provider adapter inventory is full.", 429);
        }
        await this.#write(candidate.manifest.id, {
          schemaVersion: 1,
          current: candidate,
          previous: null,
        });
        return candidate;
      });
    });
  }

  async update(input: {
    source: unknown;
    digest: unknown;
    manifest: unknown;
  }): Promise<InstalledProviderAdapter> {
    const candidate = this.inspect(input);
    return this.#serializeInventory(() =>
      this.#serialize(candidate.manifest.id, async () => {
        const existing = await this.get(candidate.manifest.id);
        if (!existing)
          throw new ProviderAdapterError("Install the adapter before updating it.", 404);
        if (compareVersions(candidate.manifest.version, existing.current.manifest.version) <= 0) {
          throw new ProviderAdapterError(
            "Adapter updates must increase the semantic version.",
            409,
          );
        }
        candidate.enabled = existing.current.enabled;
        await this.#write(candidate.manifest.id, {
          schemaVersion: 1,
          current: candidate,
          previous: existing.current,
        });
        return candidate;
      }),
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledProviderAdapter> {
    const adapterId = safeId(id);
    return this.#serializeInventory(() =>
      this.#serialize(adapterId, async () => {
        const existing = await this.get(adapterId);
        if (!existing) throw new ProviderAdapterError("Adapter is not installed.", 404);
        existing.current.enabled = enabled;
        if (existing.previous) existing.previous.enabled = enabled;
        await this.#write(adapterId, existing);
        return existing.current;
      }),
    );
  }

  async rollback(id: string): Promise<InstalledProviderAdapter> {
    const adapterId = safeId(id);
    return this.#serializeInventory(() =>
      this.#serialize(adapterId, async () => {
        const existing = await this.get(adapterId);
        if (!existing?.previous)
          throw new ProviderAdapterError("No prior adapter version is available.", 409);
        const current = existing.current;
        const previous = {
          ...existing.previous,
          enabled: current.enabled,
          installedAt: new Date().toISOString(),
        };
        await this.#write(adapterId, {
          schemaVersion: 1,
          current: previous,
          previous: current,
        });
        return previous;
      }),
    );
  }

  async uninstall(id: string): Promise<void> {
    const adapterId = safeId(id);
    await this.#serializeInventory(() =>
      this.#serialize(adapterId, () => rm(this.#path(adapterId))),
    );
  }

  async resolveExecutable(
    adapter: InstalledProviderAdapter,
    selectedPath?: string,
  ): Promise<string> {
    const allowedNames = new Set(adapter.manifest.executable.names);
    if (selectedPath !== undefined) {
      if (!isAbsolute(selectedPath) || !allowedNames.has(parse(selectedPath).base)) {
        throw new ProviderAdapterError(
          "Selected executable does not match the adapter discovery rules.",
        );
      }
      const canonical = resolve(selectedPath);
      await access(canonical, constants.X_OK);
      if (!(await stat(canonical)).isFile()) {
        throw new ProviderAdapterError("Selected executable must be an executable file.");
      }
      return canonical;
    }
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (!directory || !isAbsolute(directory)) continue;
      for (const name of allowedNames) {
        const candidate = normalize(join(directory, name));
        const relative = candidate.slice(resolve(directory).length);
        if (relative.startsWith(sep) && !relative.slice(1).includes(sep)) {
          try {
            await access(candidate, constants.X_OK);
            if ((await stat(candidate)).isFile()) return candidate;
          } catch {
            // Continue through the bounded discovery list.
          }
        }
      }
    }
    throw new ProviderAdapterError("No compatible provider executable was found.", 404);
  }

  #path(id: string): string {
    return join(this.#directory, `${id}.json`);
  }

  async #installedAdapters(): Promise<InstalledProviderAdapter[]> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await opendir(this.#directory);
    const installed: InstalledProviderAdapter[] = [];
    const seen = new Set<string>();
    let examined = 0;
    try {
      for await (const entry of directory) {
        examined += 1;
        if (examined > this.maxDirectoryEntries) {
          throw new ProviderAdapterError(
            "The provider adapter directory contains too many entries.",
            500,
          );
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const id = entry.name.slice(0, -5);
          const current = (await this.#read(id)).current;
          if (current.manifest.id !== id || seen.has(id)) continue;
          seen.add(id);
          installed.push(current);
        } catch {
          // Corrupt and unrelated JSON files do not hide valid adapter records.
        }
        if (installed.length >= this.maxAdapters) break;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return installed;
  }

  async #serializeInventory<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#inventoryQueue.then(async () => {
      await mkdir(join(this.#directory, ".."), { recursive: true, mode: 0o700 });
      const release = await lock(this.#inventoryLockPath, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 1_200, factor: 1, minTimeout: 25, maxTimeout: 25 },
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    });
    this.#inventoryQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async #serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutations.get(id) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => {}).then(() => gate);
    this.#mutations.set(id, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutations.get(id) === queued) this.#mutations.delete(id);
    }
  }

  async #read(id: string): Promise<AdapterRecord> {
    const raw = await readFile(this.#path(id), "utf8");
    if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES * 3)
      throw new ProviderAdapterError("Stored adapter metadata is oversized.");
    const value = JSON.parse(raw) as AdapterRecord;
    if (value?.schemaVersion !== 1 || !value.current)
      throw new ProviderAdapterError("Stored adapter metadata is corrupt.", 500);
    const validate = (installed: InstalledProviderAdapter): InstalledProviderAdapter => {
      if (
        installed?.schemaVersion !== 1 ||
        typeof installed.source !== "string" ||
        typeof installed.digest !== "string" ||
        typeof installed.enabled !== "boolean" ||
        typeof installed.installedAt !== "string"
      ) {
        throw new ProviderAdapterError("Stored adapter metadata is corrupt.", 500);
      }
      const manifest = parseProviderAdapterManifest(installed.manifest);
      if (adapterDigest(manifest) !== installed.digest) {
        throw new ProviderAdapterError(
          "Stored adapter metadata failed integrity verification.",
          500,
        );
      }
      return { ...installed, manifest };
    };
    return {
      schemaVersion: 1,
      current: validate(value.current),
      previous: value.previous === null ? null : validate(value.previous),
    };
  }

  async #write(id: string, value: AdapterRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.#directory, `.${safeId(id)}-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#path(id));
  }
}
