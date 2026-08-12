import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { CodexCliAdapter, CodexModel } from "./codex-provider.ts";
import { buildAcpEnvironment } from "./acp-provider.ts";
import { probeAcpModels, type AcpDiscoveredModel } from "./acp-models.ts";
import type { ProviderAdapterStore } from "./provider-adapters.ts";
import type { ProviderId, ReasoningEffort } from "./provider.ts";
import { CLAUDE_PROBE_MODELS, normalizeClaudeModelSlug } from "./profiles.ts";
import type {
  ShikigamiAdapter,
  ShikigamiModel,
  ShikigamiProfileRuntime,
} from "./shikigami-provider.ts";

const execFileAsync = promisify(execFile);
const MAX_PROBE_FILES = 100_000;
const MAX_PROBE_BYTES = 256 * 1024 * 1024;
const MAX_PROBE_ENTRIES = 200_000;
const MAX_PROBE_PREPARATION_MS = 5_000;
const MAX_ADAPTER_MODEL_DISCOVERY_MS = 13_000;
const PROBE_INDEX_RESERVE_MS = 1_000;
const PROBE_SENSITIVE_PATH =
  /(^|\/)(\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:key|pem|p12|pfx))$/i;
const BULK_PROBE_DIRECTORIES = new Set([
  ".cache",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".venv",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
]);

export interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export class ProviderModelError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface ProviderModelServices {
  codex: Pick<CodexCliAdapter, "readiness">;
  shikigami: Pick<ShikigamiAdapter, "readiness">;
  shikigamiProfile?: ShikigamiProfileRuntime;
  adapters: Pick<ProviderAdapterStore, "version" | "resolveExecutable">;
  environment?: NodeJS.ProcessEnv;
}

function providerName(provider: ProviderId): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex-cli") return "Codex";
  if (provider === "shikigami") return "Shikigami";
  return "the selected provider";
}

function modelConflict(provider: ProviderId): ProviderModelError {
  return new ProviderModelError(
    `${providerName(provider)} did not advertise the selected model. Refresh provider discovery and retry.`,
  );
}

function discoveryUnavailable(provider: ProviderId): ProviderModelError {
  return new ProviderModelError(
    `${providerName(provider)} model discovery is unavailable. Refresh provider discovery and retry.`,
  );
}

function normalizeModels(models: readonly ProviderModel[]): ProviderModel[] {
  return models
    .filter((model) => typeof model.id === "string" && model.id.trim())
    .map((model) => ({
      ...model,
      id: model.id.trim(),
      displayName: model.displayName.trim() || model.id.trim(),
    }));
}

export function claudeModelCatalog(): ProviderModel[] {
  return CLAUDE_PROBE_MODELS.map((id, index) => ({
    id,
    displayName: id,
    isDefault: index === 0,
  }));
}

export function resolveEffectiveProviderModel(
  provider: ProviderId,
  requestedModel: string,
  models: readonly ProviderModel[],
): string {
  if (
    typeof requestedModel !== "string" ||
    !requestedModel.trim() ||
    requestedModel.length > 256 ||
    requestedModel.includes("\0")
  ) {
    throw modelConflict(provider);
  }
  const available = normalizeModels(models);
  if (available.length === 0) throw discoveryUnavailable(provider);
  if (requestedModel.trim() === "default") {
    // Claude's CLI owns the default-model decision. Keep the token implicit so
    // account configuration and provider updates remain authoritative.
    if (provider === "claude-code") return "default";
    return available.find((model) => model.isDefault)?.id ?? available[0]!.id;
  }
  const requested =
    provider === "claude-code" ? normalizeClaudeModelSlug(requestedModel) : requestedModel.trim();
  const match = available.find((model) => model.id === requested);
  if (!match) throw modelConflict(provider);
  return match.id;
}

function mapCodexModels(models: readonly CodexModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  }));
}

function mapShikigamiModels(models: readonly ShikigamiModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
  }));
}

function mapAcpModels(models: readonly AcpDiscoveredModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  }));
}

interface ProbeCopyBudget {
  entries: number;
  files: number;
  bytes: number;
  truncated: boolean;
  deadline: number;
}

interface ProbeTreeContext {
  source: string;
  trackedPaths: Set<string>;
  trackedDirectories: Set<string>;
  submoduleDirectories: Set<string>;
  allowedUntrackedPaths: Set<string>;
  allowedUntrackedDirectories: Set<string>;
  allowNonGitFiles: boolean;
  branchName: string;
}

export const MAX_ACTIVE_ADAPTER_MODEL_PROBES = 4;
export const MAX_PENDING_ADAPTER_MODEL_PROBES = 32;

interface PendingAdapterModelProbe {
  resolve(release: (() => void) | null): void;
  timer: NodeJS.Timeout;
}

let activeAdapterModelProbes = 0;
const pendingAdapterModelProbes: PendingAdapterModelProbe[] = [];

function releaseAdapterModelProbeSlot(): void {
  const next = pendingAdapterModelProbes.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(releaseAdapterModelProbeSlot);
  } else {
    activeAdapterModelProbes -= 1;
  }
}

function acquireAdapterModelProbeSlot(waitMs: number): Promise<(() => void) | null> {
  if (activeAdapterModelProbes < MAX_ACTIVE_ADAPTER_MODEL_PROBES) {
    activeAdapterModelProbes += 1;
    return Promise.resolve(releaseAdapterModelProbeSlot);
  }
  if (pendingAdapterModelProbes.length >= MAX_PENDING_ADAPTER_MODEL_PROBES || waitMs <= 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const pending: PendingAdapterModelProbe = {
      resolve,
      timer: setTimeout(() => {
        const index = pendingAdapterModelProbes.indexOf(pending);
        if (index >= 0) pendingAdapterModelProbes.splice(index, 1);
        resolve(null);
      }, waitMs),
    };
    pending.timer.unref();
    pendingAdapterModelProbes.push(pending);
  });
}

/** Admit one complete temporary-workspace lifecycle through the host-wide bound. */
export async function withAdapterModelProbeAdmission<T>(
  timeoutMs: number,
  operation: (deadline: number) => Promise<T>,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  const release = await acquireAdapterModelProbeSlot(timeoutMs);
  if (!release) return null;
  try {
    if (deadline <= Date.now()) return null;
    return await operation(deadline);
  } finally {
    release();
  }
}

function remainingProbeTime(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return code === 128 && /not a git repository/i.test(stderr);
}

async function probeTreeContext(source: string, deadline: number): Promise<ProbeTreeContext> {
  let isGitWorktree = false;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", source, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", timeout: remainingProbeTime(deadline) },
    );
    isGitWorktree = stdout.trim() === "true";
  } catch (error) {
    if (!isNotGitRepositoryError(error)) throw error;
  }
  if (!isGitWorktree) {
    return {
      source,
      trackedPaths: new Set(),
      trackedDirectories: new Set(),
      submoduleDirectories: new Set(),
      allowedUntrackedPaths: new Set(),
      allowedUntrackedDirectories: new Set(),
      allowNonGitFiles: true,
      branchName: "probe",
    };
  }
  const { stdout } = await execFileAsync("git", ["-C", source, "ls-files", "-s", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: remainingProbeTime(deadline),
  });
  const trackedPaths = new Set<string>();
  const submoduleDirectories = new Set<string>();
  for (const record of stdout.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator === -1) {
      trackedPaths.add(record);
      continue;
    }
    const metadata = record.slice(0, separator);
    const path = record.slice(separator + 1);
    trackedPaths.add(path);
    if (metadata.startsWith("160000 ")) submoduleDirectories.add(path);
  }
  const trackedDirectories = new Set<string>();
  for (const trackedPath of trackedPaths) {
    const parts = trackedPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      trackedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  const { stdout: untrackedOutput } = await execFileAsync(
    "git",
    ["-C", source, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: remainingProbeTime(deadline) },
  );
  const allowedUntrackedPaths = new Set(
    untrackedOutput.split("\0").filter((path) => path && !PROBE_SENSITIVE_PATH.test(path)),
  );
  const allowedUntrackedDirectories = new Set<string>();
  for (const untrackedPath of allowedUntrackedPaths) {
    const parts = untrackedPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      allowedUntrackedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  let branchName = "probe";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", source, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { encoding: "utf8", timeout: remainingProbeTime(deadline) },
    );
    if (/^[A-Za-z0-9._/-]+$/.test(stdout.trim())) branchName = stdout.trim();
  } catch {
    // Detached HEADs retain the synthetic probe branch.
  }
  for (const submodule of submoduleDirectories) {
    const childRoot = join(source, ...submodule.split("/"));
    try {
      const child = await probeTreeContext(childRoot, deadline);
      if (child.allowNonGitFiles) continue;
      const prefix = `${submodule}/`;
      for (const path of child.trackedPaths) trackedPaths.add(`${prefix}${path}`);
      for (const path of child.trackedDirectories) trackedDirectories.add(`${prefix}${path}`);
      for (const path of child.submoduleDirectories) submoduleDirectories.add(`${prefix}${path}`);
      for (const path of child.allowedUntrackedPaths) allowedUntrackedPaths.add(`${prefix}${path}`);
      for (const path of child.allowedUntrackedDirectories) {
        allowedUntrackedDirectories.add(`${prefix}${path}`);
      }
    } catch {
      // An unavailable submodule classification remains an empty submodule snapshot.
    }
  }
  return {
    source,
    trackedPaths,
    trackedDirectories,
    submoduleDirectories,
    allowedUntrackedPaths,
    allowedUntrackedDirectories,
    allowNonGitFiles: false,
    branchName,
  };
}

async function isIgnoredProbeDirectory(
  context: ProbeTreeContext,
  relativePath: string,
  timeoutMs: number,
): Promise<boolean> {
  if (context.allowNonGitFiles) {
    return BULK_PROBE_DIRECTORIES.has(relativePath.split("/").at(-1) ?? "");
  }
  if (
    !BULK_PROBE_DIRECTORIES.has(relativePath.split("/").at(-1) ?? "") ||
    context.trackedPaths.has(relativePath) ||
    context.trackedDirectories.has(relativePath)
  ) {
    return false;
  }
  try {
    await execFileAsync("git", ["-C", context.source, "check-ignore", "-q", "--", relativePath], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !difference.startsWith(sep))
  );
}

async function copyProbeSymlink(
  sourcePath: string,
  destinationPath: string,
  context: ProbeTreeContext,
  destinationRoot: string,
): Promise<void> {
  await rm(destinationPath, { recursive: true, force: true });
  const resolvedTarget = await realpath(sourcePath).catch(() => null);
  if (!resolvedTarget || !pathIsInside(context.source, resolvedTarget)) return;
  const targetRelative = relative(context.source, resolvedTarget);
  if (targetRelative === ".git" || targetRelative.startsWith(`.git${sep}`)) return;
  const destinationTarget = join(destinationRoot, targetRelative);
  const linkTarget = relative(dirname(destinationPath), destinationTarget) || ".";
  await symlink(linkTarget, destinationPath).catch(() => undefined);
}

async function copyProbeWorkingTree(
  source: string,
  destination: string,
  budget: ProbeCopyBudget,
  context: ProbeTreeContext,
  relativeDirectory = "",
  destinationRoot = destination,
): Promise<void> {
  if (budget.truncated || Date.now() >= budget.deadline) {
    budget.truncated = true;
    return;
  }
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => {
    const leftPath = relativeDirectory ? `${relativeDirectory}/${left.name}` : left.name;
    const rightPath = relativeDirectory ? `${relativeDirectory}/${right.name}` : right.name;
    const leftTracked =
      context.trackedPaths.has(leftPath) || context.trackedDirectories.has(leftPath);
    const rightTracked =
      context.trackedPaths.has(rightPath) || context.trackedDirectories.has(rightPath);
    return Number(rightTracked) - Number(leftTracked) || left.name.localeCompare(right.name);
  });
  for (const entry of entries) {
    if (budget.truncated || Date.now() >= budget.deadline) {
      budget.truncated = true;
      return;
    }
    if (entry.name === ".git") continue;

    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const stats = await lstat(sourcePath);
    budget.entries += 1;
    if (budget.entries > MAX_PROBE_ENTRIES) {
      budget.truncated = true;
      return;
    }
    if (stats.isSymbolicLink()) {
      if (
        PROBE_SENSITIVE_PATH.test(relativePath) ||
        (!context.allowNonGitFiles &&
          !context.trackedPaths.has(relativePath) &&
          !context.allowedUntrackedPaths.has(relativePath))
      )
        continue;
      await copyProbeSymlink(sourcePath, destinationPath, context, destinationRoot);
      continue;
    }
    if (stats.isDirectory()) {
      const hasAllowedContent =
        context.trackedPaths.has(relativePath) ||
        context.trackedDirectories.has(relativePath) ||
        context.submoduleDirectories.has(relativePath) ||
        context.allowedUntrackedPaths.has(relativePath) ||
        context.allowedUntrackedDirectories.has(relativePath) ||
        context.allowNonGitFiles;
      if (!hasAllowedContent) continue;
      if (
        await isIgnoredProbeDirectory(
          context,
          relativePath,
          Math.max(1, budget.deadline - Date.now()),
        )
      )
        continue;
      await rm(destinationPath, { recursive: true, force: true });
      await mkdir(destinationPath, { recursive: true, mode: 0o700 });
      await copyProbeWorkingTree(
        sourcePath,
        destinationPath,
        budget,
        context,
        relativePath,
        destinationRoot,
      );
      continue;
    }
    if (!stats.isFile()) {
      await rm(destinationPath, { recursive: true, force: true });
      continue;
    }
    if (
      PROBE_SENSITIVE_PATH.test(relativePath) ||
      (!context.allowNonGitFiles &&
        !context.trackedPaths.has(relativePath) &&
        !context.allowedUntrackedPaths.has(relativePath))
    )
      continue;
    if (budget.files >= MAX_PROBE_FILES) {
      budget.truncated = true;
      return;
    }
    if (budget.bytes + stats.size > MAX_PROBE_BYTES) {
      budget.truncated = true;
      continue;
    }
    await rm(destinationPath, { recursive: true, force: true });
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, stats.mode & 0o700 || 0o600);
    budget.files += 1;
    budget.bytes += stats.size;
  }
}

async function createAcpProbeWorkspace(
  source: string,
  operationDeadline: number,
): Promise<{
  processDirectory: string;
  sessionDirectory: string;
}> {
  const sourceRoot = await realpath(source);
  const deadline = Math.min(operationDeadline, Date.now() + MAX_PROBE_PREPARATION_MS);
  const processDirectory = await mkdtemp(join(tmpdir(), "aldunis-provider-model-probe-"));
  const sessionDirectory = await mkdtemp(join(tmpdir(), "aldunis-provider-model-session-"));
  try {
    const context = await probeTreeContext(sourceRoot, deadline);
    await execFileAsync("git", ["init", "-q", sessionDirectory], {
      encoding: "utf8",
      timeout: remainingProbeTime(deadline),
    });
    await execFileAsync(
      "git",
      ["-C", sessionDirectory, "symbolic-ref", "HEAD", `refs/heads/${context.branchName}`],
      { encoding: "utf8", timeout: remainingProbeTime(deadline) },
    );
    await execFileAsync(
      "git",
      ["-C", sessionDirectory, "remote", "add", "origin", "https://aldunis.invalid/probe-origin"],
      { encoding: "utf8", timeout: remainingProbeTime(deadline) },
    );
    const { stdout: emptyTree } = await execFileAsync(
      "git",
      ["-C", sessionDirectory, "write-tree"],
      { encoding: "utf8", timeout: remainingProbeTime(deadline) },
    );
    const { stdout: emptyCommit } = await execFileAsync(
      "git",
      ["-C", sessionDirectory, "commit-tree", emptyTree.trim(), "-m", "probe snapshot"],
      {
        encoding: "utf8",
        timeout: remainingProbeTime(deadline),
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Aldunis model probe",
          GIT_AUTHOR_EMAIL: "aldunis-model-probe@localhost",
          GIT_COMMITTER_NAME: "Aldunis model probe",
          GIT_COMMITTER_EMAIL: "aldunis-model-probe@localhost",
        },
      },
    );
    await execFileAsync("git", ["-C", sessionDirectory, "update-ref", "HEAD", emptyCommit.trim()], {
      encoding: "utf8",
      timeout: remainingProbeTime(deadline),
    });
    const budget: ProbeCopyBudget = {
      entries: 0,
      files: 0,
      bytes: 0,
      truncated: false,
      deadline: deadline - PROBE_INDEX_RESERVE_MS,
    };
    await copyProbeWorkingTree(sourceRoot, sessionDirectory, budget, context, "", sessionDirectory);
    // A bounded copy may be partial; keep it isolated and object-limited so
    // adapters can still advertise context-free models without seeing secrets.
    if (!budget.truncated) {
      try {
        await execFileAsync("git", ["-C", sessionDirectory, "add", "-A", "-f", "--", "."], {
          encoding: "utf8",
          timeout: remainingProbeTime(deadline),
        });
        const { stdout: tree } = await execFileAsync(
          "git",
          ["-C", sessionDirectory, "write-tree"],
          { encoding: "utf8", timeout: remainingProbeTime(deadline) },
        );
        const { stdout: probeCommit } = await execFileAsync(
          "git",
          ["-C", sessionDirectory, "commit-tree", tree.trim(), "-m", "probe snapshot"],
          {
            encoding: "utf8",
            timeout: remainingProbeTime(deadline),
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Aldunis model probe",
              GIT_AUTHOR_EMAIL: "aldunis-model-probe@localhost",
              GIT_COMMITTER_NAME: "Aldunis model probe",
              GIT_COMMITTER_EMAIL: "aldunis-model-probe@localhost",
            },
          },
        );
        await execFileAsync(
          "git",
          ["-C", sessionDirectory, "update-ref", "HEAD", probeCommit.trim()],
          { encoding: "utf8", timeout: remainingProbeTime(deadline) },
        );
      } catch {
        await rm(join(sessionDirectory, ".git", "index.lock"), { force: true }).catch(
          () => undefined,
        );
      }
    }
    await chmod(sessionDirectory, 0o700);
    return { processDirectory, sessionDirectory };
  } catch (error) {
    await rm(processDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function discoverAdapterModels(
  provider: ProviderId,
  services: ProviderModelServices,
  cwd: string,
): Promise<ProviderModel[]> {
  const installed = await services.adapters.version(provider);
  if (!installed || !installed.enabled) throw discoveryUnavailable(provider);
  let executable: string;
  let environment: NodeJS.ProcessEnv;
  try {
    executable = await services.adapters.resolveExecutable(installed);
    environment = buildAcpEnvironment(installed, services.environment);
  } catch {
    throw discoveryUnavailable(provider);
  }
  const models = await withAdapterModelProbeAdmission(
    MAX_ADAPTER_MODEL_DISCOVERY_MS,
    async (deadline) => {
      let probeWorkspace: { processDirectory: string; sessionDirectory: string };
      try {
        probeWorkspace = await createAcpProbeWorkspace(cwd, deadline);
      } catch {
        return [];
      }
      try {
        if (deadline <= Date.now()) return [];
        // Model discovery is a provider subprocess operation. Give it an isolated
        // snapshot of the selected revision, so session/new sees the same project
        // context without exposing or mutating the user's live worktree before the
        // run checkpoint is captured.
        return await probeAcpModels({
          executable,
          arguments: installed.manifest.executable.arguments,
          environment,
          cwd: probeWorkspace.processDirectory,
          sessionCwd: probeWorkspace.sessionDirectory,
          timeoutMs: remainingProbeTime(deadline),
        }).catch(() => []);
      } finally {
        await rm(probeWorkspace.processDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        await rm(probeWorkspace.sessionDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
  );
  if (!models || models.length === 0) throw discoveryUnavailable(provider);
  return mapAcpModels(models);
}

export async function discoverProviderModels(
  provider: ProviderId,
  services: ProviderModelServices,
  cwd: string,
): Promise<ProviderModel[]> {
  if (provider === "claude-code") return claudeModelCatalog();
  if (provider === "codex-cli") {
    const readiness = await services.codex.readiness().catch(() => null);
    if (!readiness?.installed || !readiness.authenticated || readiness.models.length === 0) {
      throw discoveryUnavailable(provider);
    }
    return mapCodexModels(readiness.models);
  }
  if (provider === "shikigami") {
    const readiness = await services.shikigami
      .readiness(services.shikigamiProfile?.environment, {
        executable: services.shikigamiProfile?.executable,
        configPath: services.shikigamiProfile?.configPath,
        cwd,
      })
      .catch(() => null);
    if (!readiness?.installed || !readiness.authenticated || readiness.models.length === 0) {
      throw discoveryUnavailable(provider);
    }
    return mapShikigamiModels(readiness.models);
  }
  return discoverAdapterModels(provider, services, cwd);
}

export async function validateProviderModel(
  provider: ProviderId,
  requestedModel: string,
  services: ProviderModelServices,
  cwd: string,
): Promise<string> {
  const models = await discoverProviderModels(provider, services, cwd);
  return resolveEffectiveProviderModel(provider, requestedModel, models);
}

export function isAdapterProviderId(value: string): value is `adapter:${string}@${string}` {
  return value.startsWith("adapter:") && value.includes("@");
}
