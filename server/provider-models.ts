import { execFile, spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
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
const PROBE_COPY_BUFFER_BYTES = 256 * 1024;
const MAX_PROBE_PATH_BYTES = 64 * 1024;
const MAX_PROBE_STDERR_BYTES = 64 * 1024;
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
  const trackedPaths = new Set<string>();
  const submoduleDirectories = new Set<string>();
  const trackedDirectories = new Set<string>();
  const allowedUntrackedPaths = new Set<string>();
  const allowedUntrackedDirectories = new Set<string>();
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

function sameProbeFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Copy one admitted probe file without allowing a pathname race to exceed its charged size. */
export async function copyStableProbeFile(
  sourcePath: string,
  destinationPath: string,
  admitted: Stats,
): Promise<void> {
  const source = await open(sourcePath, "r");
  let destination: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const opened = await source.stat();
    if (!sameProbeFile(admitted, opened)) throw new Error("Probe source changed before copying.");
    destination = await open(destinationPath, "w", admitted.mode & 0o700 || 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(PROBE_COPY_BUFFER_BYTES, admitted.size + 1));
    let position = 0;
    while (position < admitted.size) {
      const length = Math.min(buffer.length, admitted.size - position);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error("Probe source shrank while copying.");
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0) throw new Error("Probe destination write did not advance.");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if ((await source.read(buffer, 0, 1, admitted.size)).bytesRead !== 0) {
      throw new Error("Probe source grew while copying.");
    }
    const [after, pathname] = await Promise.all([source.stat(), lstat(sourcePath)]);
    if (!sameProbeFile(admitted, after) || !sameProbeFile(after, pathname)) {
      throw new Error("Probe source changed while copying.");
    }
    await destination.chmod(admitted.mode & 0o700 || 0o600);
  } catch (error) {
    await destination?.close().catch(() => undefined);
    destination = null;
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([destination?.close(), source.close()]);
  }
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

async function streamGitProbePaths(
  source: string,
  args: string[],
  deadline: number,
  admit: (path: string) => Promise<boolean>,
): Promise<boolean> {
  if (Date.now() >= deadline) return false;
  const child = spawn("git", ["-C", source, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    },
  );
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let pending = Buffer.alloc(0);
  let stoppedEarly = false;
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), 250);
    escalation.unref?.();
  };
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_PROBE_STDERR_BYTES) return;
    const retained = chunk.subarray(0, MAX_PROBE_STDERR_BYTES - stderrBytes);
    stderr.push(Buffer.from(retained));
    stderrBytes += retained.length;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, remainingProbeTime(deadline));
  timeout.unref?.();
  try {
    outer: for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      const joined = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (;;) {
        const end = joined.indexOf(0, start);
        if (end < 0) break;
        if (end - start > MAX_PROBE_PATH_BYTES) {
          throw new Error("Provider model probe path exceeded its resource limit.");
        }
        if (!(await admit(joined.toString("utf8", start, end)))) {
          stoppedEarly = true;
          stop();
          break outer;
        }
        start = end + 1;
      }
      pending = Buffer.from(joined.subarray(start));
      if (pending.length > MAX_PROBE_PATH_BYTES) {
        throw new Error("Provider model probe path exceeded its resource limit.");
      }
    }
    const completion = await exit;
    if (timedOut) throw new Error("Provider model probe inventory timed out.");
    if (!stoppedEarly && pending.length > 0) {
      throw new Error("Git returned an incomplete provider model probe inventory.");
    }
    if (!stoppedEarly && completion.code !== 0) {
      throw new Error(
        Buffer.concat(stderr, stderrBytes).toString("utf8").trim() ||
          "Git could not enumerate provider model probe paths.",
      );
    }
    return !stoppedEarly;
  } finally {
    clearTimeout(timeout);
    stop();
    await exit.catch(() => undefined);
    if (escalation) clearTimeout(escalation);
  }
}

function safeProbePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

async function copyGitProbePath(
  source: string,
  destination: string,
  relativePath: string,
  budget: ProbeCopyBudget,
  context: ProbeTreeContext,
  entryCharge: number,
  allowGitlink: boolean,
  blockedDirectories: Set<string>,
): Promise<boolean> {
  if (budget.truncated || Date.now() >= budget.deadline) {
    budget.truncated = true;
    return false;
  }
  budget.entries += entryCharge;
  if (budget.entries > MAX_PROBE_ENTRIES) {
    budget.truncated = true;
    return false;
  }
  if (!safeProbePath(relativePath) || PROBE_SENSITIVE_PATH.test(relativePath)) return true;
  const sourcePath = join(source, ...relativePath.split("/"));
  const destinationPath = join(destination, ...relativePath.split("/"));
  const stats = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENAMETOOLONG") return null;
    throw error;
  });
  if (!stats) return true;
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  if (stats.isSymbolicLink()) {
    await copyProbeSymlink(sourcePath, destinationPath, context, destination);
    return true;
  }
  if (stats.isDirectory()) {
    if (!allowGitlink) {
      blockedDirectories.add(relativePath);
      await rm(destinationPath, { recursive: true, force: true });
      return true;
    }
    await rm(destinationPath, { recursive: true, force: true });
    await mkdir(destinationPath, { recursive: true, mode: 0o700 });
    try {
      const childContext = await probeTreeContext(sourcePath, budget.deadline);
      if (!childContext.allowNonGitFiles) {
        await copyGitProbeWorkingTree(sourcePath, destinationPath, budget, childContext);
      }
    } catch {
      // An unavailable submodule remains an empty submodule snapshot.
    }
    return !budget.truncated;
  }
  if (!stats.isFile()) {
    await rm(destinationPath, { recursive: true, force: true });
    return true;
  }
  if (budget.files >= MAX_PROBE_FILES) {
    budget.truncated = true;
    return false;
  }
  if (budget.bytes + stats.size > MAX_PROBE_BYTES) {
    budget.truncated = true;
    return false;
  }
  await rm(destinationPath, { recursive: true, force: true });
  await copyStableProbeFile(sourcePath, destinationPath, stats);
  budget.files += 1;
  budget.bytes += stats.size;
  return true;
}

async function copyGitProbeWorkingTree(
  source: string,
  destination: string,
  budget: ProbeCopyBudget,
  context: ProbeTreeContext,
): Promise<void> {
  let previousDirectories: string[] = [];
  const blockedDirectories = new Set<string>();
  const isBlocked = (path: string) => {
    const parts = path.split("/");
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
      if (blockedDirectories.has(prefix)) return true;
    }
    return false;
  };
  const admit = (path: string, allowGitlink: boolean) => {
    const directories = path.split("/").slice(0, -1);
    let shared = 0;
    while (
      shared < previousDirectories.length &&
      shared < directories.length &&
      previousDirectories[shared] === directories[shared]
    ) {
      shared += 1;
    }
    previousDirectories = directories;
    return copyGitProbePath(
      source,
      destination,
      path,
      budget,
      context,
      1 + directories.length - shared,
      allowGitlink,
      blockedDirectories,
    );
  };
  let previousTrackedPath: string | null = null;
  const trackedComplete = await streamGitProbePaths(
    source,
    ["ls-files", "--stage", "-z"],
    budget.deadline,
    async (record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) throw new Error("Git returned invalid provider model probe metadata.");
      const metadata = record.slice(0, separator);
      const match = /^([0-7]{6}) [0-9a-f]+ [0-3]$/.exec(metadata);
      if (!match) throw new Error("Git returned invalid provider model probe metadata.");
      const path = record.slice(separator + 1);
      if (path === previousTrackedPath) return true;
      previousTrackedPath = path;
      return admit(path, match[1] === "160000");
    },
  );
  if (!trackedComplete) budget.truncated = true;
  if (budget.truncated) return;
  previousDirectories = [];
  const untrackedComplete = await streamGitProbePaths(
    source,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    budget.deadline,
    (path) => {
      if (isBlocked(path)) return Promise.resolve(true);
      return admit(path, false);
    },
  );
  if (!untrackedComplete) budget.truncated = true;
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
    await copyStableProbeFile(sourcePath, destinationPath, stats);
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
    if (context.allowNonGitFiles) {
      await copyProbeWorkingTree(
        sourceRoot,
        sessionDirectory,
        budget,
        context,
        "",
        sessionDirectory,
      );
    } else {
      await copyGitProbeWorkingTree(sourceRoot, sessionDirectory, budget, context);
    }
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
