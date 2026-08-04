import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";
import {
  canonicalizeRepositoryRoot,
  classifyWorktree,
  discoverWorktrees,
  repositoryDefaultBranch,
  RepositoryError,
  type WorktreeMetadata,
} from "./repository.ts";

const execFileAsync = promisify(execFile);
const REGISTRY_SCHEMA_VERSION = 1;
const PLAN_TTL_MS = 5 * 60_000;

export type ManagedWorktreeRecovery = "available" | "moved" | "missing" | "inaccessible";

export interface ManagedWorktreeRecord {
  schemaVersion: 1;
  id: string;
  repository: string;
  path: string;
  branch: string;
  baseRevision: string;
  createdAt: string;
  lastUsedAt: string;
  removalPendingAt: string | null;
  removedAt: string | null;
}

export interface ManagedWorktreeRegistry {
  schemaVersion: 1;
  records: ManagedWorktreeRecord[];
}

export interface WorktreeView extends WorktreeMetadata {
  ownership: "aldunis" | "user";
  recovery: ManagedWorktreeRecovery;
  originalPath: string | null;
}

export interface WorktreeCreationPlan {
  id: string;
  action: "create";
  repository: string;
  base: string;
  baseRevision: string;
  branch: string;
  path: string;
  expiresAt: string;
}

export interface WorktreeRemovalPlan {
  id: string;
  action: "remove";
  repository: string;
  branch: string;
  path: string;
  recordId: string;
  head: string;
  gitDirectory: string;
  device: number;
  inode: number;
  directoryChangeTimeNs: string;
  gitMarkerChangeTimeNs: string;
  expiresAt: string;
}

type WorktreePlan = WorktreeCreationPlan | WorktreeRemovalPlan;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countActiveManaged(registry: ManagedWorktreeRegistry): number {
  return registry.records.filter((record) => !record.removedAt && !record.removalPendingAt).length;
}

async function findManagedByPath(
  registry: ManagedWorktreeRegistry,
  pathInput: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const retained = registry.records.filter((record) => !record.removedAt);
  const exact = retained.find((record) => record.path === pathInput);
  if (exact) return exact;
  try {
    const resolved = await realpath(pathInput);
    return retained.find((record) => record.path === resolved);
  } catch {
    return undefined;
  }
}

function parseRegistry(value: unknown): ManagedWorktreeRegistry {
  if (!isRecord(value) || value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.records)) {
    throw new RepositoryError("Managed worktree history uses an incompatible schema.", 409);
  }
  const records = value.records.map((candidate) => {
    if (
      !isRecord(candidate)
      || candidate.schemaVersion !== REGISTRY_SCHEMA_VERSION
      || typeof candidate.id !== "string"
      || typeof candidate.repository !== "string"
      || typeof candidate.path !== "string"
      || typeof candidate.branch !== "string"
      || typeof candidate.baseRevision !== "string"
      || typeof candidate.createdAt !== "string"
      || typeof candidate.lastUsedAt !== "string"
      || (
        candidate.removalPendingAt !== undefined
        && candidate.removalPendingAt !== null
        && typeof candidate.removalPendingAt !== "string"
      )
      || (candidate.removedAt !== null && typeof candidate.removedAt !== "string")
    ) {
      throw new RepositoryError("Managed worktree history is corrupt.", 409);
    }
    return {
      ...(candidate as unknown as Omit<ManagedWorktreeRecord, "removalPendingAt">),
      removalPendingAt: candidate.removalPendingAt as string | null | undefined ?? null,
    };
  });
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, records };
}

async function git(cwd: string, args: string[], failure: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: string };
    const message = `${detail.message ?? ""}\n${detail.stderr ?? ""}`;
    if (message.includes("timed out")) {
      throw new RepositoryError("Git did not finish while preparing the isolated worktree.", 409);
    }
    throw new RepositoryError(failure, 409);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RepositoryError("The worktree path is inaccessible.", 409);
  }
}

async function canonicalFuturePath(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new RepositoryError("The worktree path must be absolute.");
  const target = resolve(input);
  const parent = await realpath(dirname(target)).catch(() => {
    throw new RepositoryError("The worktree parent directory is missing or inaccessible.", 409);
  });
  try {
    await access(parent, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new RepositoryError("The worktree parent directory is not writable.", 409);
  }
  return join(parent, basename(target));
}

async function assertNoGitLocks(root: string): Promise<void> {
  const raw = (await git(root, ["rev-parse", "--git-common-dir"], "The Git directory is unavailable.")).trim();
  const common = await realpath(resolve(root, raw));
  const lockPaths = [
    join(common, "index.lock"),
    join(common, "HEAD.lock"),
    join(common, "packed-refs.lock"),
    join(common, "shallow.lock"),
    join(common, "config.lock"),
  ];
  if ((await Promise.all(lockPaths.map(pathExists))).some(Boolean)) {
    throw new RepositoryError("Another Git operation is in progress. Wait for it to finish and preview again.", 409);
  }
}

export function hasStagedChanges(status: string): boolean {
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const indexStatus = entry[0];
    if (indexStatus !== " " && indexStatus !== "?") return true;
    if (entry[1] === "R" || entry[1] === "C") index += 1;
  }
  return false;
}

async function validateRepositoryForCreation(root: string, base: string, branch: string): Promise<string> {
  await assertNoGitLocks(root);
  const currentBranch = (await git(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "Worktree creation is unavailable while the selected repository has a detached HEAD.",
  )).trim();
  if (!currentBranch) {
    throw new RepositoryError(
      "Worktree creation is unavailable while the selected repository has a detached HEAD.",
      409,
    );
  }
  const status = await git(root, ["status", "--porcelain=v1", "-z"], "The repository state could not be inspected.");
  if (hasStagedChanges(status)) {
    throw new RepositoryError("Stage or discard indexed changes before creating an isolated worktree.", 409);
  }
  const modes = await git(root, ["ls-files", "--stage"], "Repository files could not be inspected.");
  if (modes.split("\n").some((line) => line.startsWith("160000 "))) {
    throw new RepositoryError("Worktree creation is unavailable for repositories containing submodules.", 409);
  }
  await git(
    root,
    ["check-ref-format", "--branch", branch],
    "The branch name is invalid. Choose a normal local branch name.",
  );
  try {
    await execFileAsync("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      timeout: 5_000,
    });
    throw new RepositoryError("That branch already exists. Select its worktree or choose another name.", 409);
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    const code = (error as { code?: string | number }).code;
    if (code !== 1 && code !== undefined) {
      throw new RepositoryError("Existing branches could not be inspected.", 409);
    }
  }
  return (await git(
    root,
    ["rev-parse", "--verify", `${base}^{commit}`],
    "The selected base revision does not exist.",
  )).trim();
}

export class ManagedWorktreeStore {
  readonly #path: string;

  constructor(readonly directory: string) {
    this.#path = join(directory, "worktrees.v1.json");
  }

  async load(): Promise<ManagedWorktreeRegistry> {
    try {
      return parseRegistry(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: REGISTRY_SCHEMA_VERSION, records: [] };
      }
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("Managed worktree history is corrupt.", 409);
    }
  }

  async save(records: ManagedWorktreeRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      records,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#path);
  }
}

export class WorktreeManager {
  readonly #plans = new Map<string, WorktreePlan>();
  #operationActive = false;

  constructor(
    readonly directory: string,
    readonly store = new ManagedWorktreeStore(directory),
  ) {}

  async list(repositoryInput: string): Promise<WorktreeView[]> {
    const repository = await canonicalizeRepositoryRoot(repositoryInput);
    const [discovered, registry] = await Promise.all([
      discoverWorktrees(repository),
      this.store.load(),
    ]);
    const owned = registry.records.filter((record) => record.repository === repository && !record.removedAt);
    const byPath = new Map(owned.map((record) => [record.path, record]));
    const byBranch = new Map(owned.map((record) => [record.branch, record]));
    const views: WorktreeView[] = discovered.map((worktree) => {
      const record = byPath.get(worktree.path) ?? (worktree.branch ? byBranch.get(worktree.branch) : undefined);
      return {
        ...worktree,
        ownership: record ? "aldunis" : "user",
        recovery: record && record.path !== worktree.path
          ? "moved"
          : worktree.state === "inaccessible"
            ? "inaccessible"
            : worktree.state === "missing"
              ? "missing"
              : "available",
        originalPath: record && record.path !== worktree.path ? record.path : null,
      };
    });
    const discoveredOwnedIds = new Set(
      views.flatMap((view) => {
        const record = byPath.get(view.path) ?? (view.branch ? byBranch.get(view.branch) : undefined);
        return record ? [record.id] : [];
      }),
    );
    for (const record of owned) {
      if (discoveredOwnedIds.has(record.id)) continue;
      const state = await classifyWorktree(record.path, false);
      views.push({
        path: record.path,
        head: record.baseRevision,
        branch: record.branch,
        state,
        ownership: "aldunis",
        recovery: state === "inaccessible" ? "inaccessible" : "missing",
        originalPath: null,
      });
    }
    return views;
  }

  async previewCreate(input: {
    repository: string;
    base: string;
    branch: string;
    path?: string | null;
    limit: number | null;
  }): Promise<WorktreeCreationPlan> {
    const repository = await canonicalizeRepositoryRoot(input.repository);
    const branch = input.branch.trim();
    if (!branch) throw new RepositoryError("A new branch is required.");
    const base = await repositoryDefaultBranch(repository);
    if (!base) {
      throw new RepositoryError(
        "The repository default branch could not be determined. Configure a single remote HEAD or use a conventional default branch.",
        409,
      );
    }
    const registry = await this.store.load();
    const managed = registry.records.filter((record) => !record.removedAt && !record.removalPendingAt);
    if (input.limit !== null && managed.length >= input.limit) {
      throw new RepositoryError(
        `This installation has reached its ${input.limit}-worktree managed limit. Remove an eligible Aldunis worktree or raise the limit.`,
        429,
      );
    }
    const baseRevision = await validateRepositoryForCreation(repository, base, branch);
    const suggested = join(this.directory, "worktrees", basename(repository), branch.replaceAll("/", "-"));
    await mkdir(dirname(suggested), { recursive: true, mode: 0o700 });
    const path = await canonicalFuturePath(input.path?.trim() || suggested);
    const discovered = await discoverWorktrees(repository);
    for (const worktree of discovered) {
      try {
        const existing = await realpath(worktree.path);
        if (isPathInside(existing, path)) {
          throw new RepositoryError("The new worktree path cannot be inside an existing repository worktree.", 409);
        }
      } catch (error) {
        if (error instanceof RepositoryError) throw error;
      }
    }
    if (await pathExists(path)) {
      throw new RepositoryError("The worktree path already exists. Select it or choose another path.", 409);
    }
    if (managed.some((record) => (
      record.path === path
      || (record.repository === repository && record.branch === branch)
    ))) {
      throw new RepositoryError("That branch or path is already registered as an Aldunis worktree.", 409);
    }
    const plan: WorktreeCreationPlan = {
      id: randomUUID(),
      action: "create",
      repository,
      base,
      baseRevision,
      branch,
      path,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    };
    this.#plans.set(plan.id, plan);
    return plan;
  }

  async create(planId: string, limit: number | null): Promise<ManagedWorktreeRecord> {
    const plan = this.#consumePlan(planId, "create");
    return this.#exclusive(plan.repository, async () => {
      const registry = await this.store.load();
      const managed = registry.records.filter((record) => !record.removedAt && !record.removalPendingAt);
      if (limit !== null && managed.length >= limit) {
        throw new RepositoryError("The managed worktree limit changed. Preview creation again.", 409);
      }
      const baseRevision = await validateRepositoryForCreation(plan.repository, plan.baseRevision, plan.branch);
      if (baseRevision !== plan.baseRevision || await pathExists(plan.path)) {
        throw new RepositoryError("The approved worktree creation changed. Preview it again.", 409);
      }
      await git(
        plan.repository,
        ["worktree", "add", "-b", plan.branch, plan.path, plan.baseRevision],
        "Git could not create the isolated worktree. No cleanup or branch deletion was attempted.",
      );
      const now = new Date().toISOString();
      const record: ManagedWorktreeRecord = {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        id: randomUUID(),
        repository: plan.repository,
        path: await realpath(plan.path),
        branch: plan.branch,
        baseRevision: plan.baseRevision,
        createdAt: now,
        lastUsedAt: now,
        removalPendingAt: null,
        removedAt: null,
      };
      try {
        await this.store.save([...registry.records, record]);
      } catch {
        throw new RepositoryError(
          `The worktree was created at ${record.path}, but ownership metadata could not be saved. It was left intact and must be opened as a user-created worktree.`,
          500,
        );
      }
      return record;
    });
  }

  creationPlan(id: string): WorktreeCreationPlan {
    const plan = this.#plans.get(id);
    if (!plan || plan.action !== "create") {
      throw new RepositoryError("The worktree approval is missing or already used.", 409);
    }
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      this.#plans.delete(id);
      throw new RepositoryError("The worktree approval expired. Preview it again.", 409);
    }
    return { ...plan };
  }

  async previewRemove(repositoryInput: string, pathInput: string): Promise<WorktreeRemovalPlan> {
    const repository = await canonicalizeRepositoryRoot(repositoryInput);
    const path = await realpath(pathInput).catch(() => {
      throw new RepositoryError("The managed worktree is missing or inaccessible.", 409);
    });
    const registry = await this.store.load();
    const record = registry.records.find(
      (candidate) => candidate.repository === repository
        && candidate.path === path
        && !candidate.removedAt,
    );
    if (!record) throw new RepositoryError("Only Aldunis-owned worktrees can be removed here.", 403);
    await assertNoGitLocks(repository);
    await assertRemovableWorktree(path);
    const identity = await inspectWorktreeIdentity(path);
    if (identity.branch !== record.branch) {
      throw new RepositoryError("The managed worktree branch no longer matches its ownership record.", 409);
    }
    const plan: WorktreeRemovalPlan = {
      id: randomUUID(),
      action: "remove",
      repository,
      branch: record.branch,
      path,
      recordId: record.id,
      ...identity,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    };
    this.#plans.set(plan.id, plan);
    return plan;
  }

  removalPlan(id: string): WorktreeRemovalPlan {
    const plan = this.#plans.get(id);
    if (!plan || plan.action !== "remove") {
      throw new RepositoryError("The worktree approval is missing or already used.", 409);
    }
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      this.#plans.delete(id);
      throw new RepositoryError("The worktree approval expired. Preview it again.", 409);
    }
    return { ...plan };
  }

  discardPlan(id: string): void {
    this.#plans.delete(id);
  }

  async remove(planId: string): Promise<void> {
    const plan = this.#consumePlan(planId, "remove");
    await this.#exclusive(plan.repository, async () => {
      const registry = await this.store.load();
      const record = registry.records.find(
        (candidate) => candidate.id === plan.recordId
          && candidate.repository === plan.repository
          && candidate.path === plan.path
          && candidate.branch === plan.branch
          && !candidate.removedAt,
      );
      if (!record) throw new RepositoryError("The approved managed worktree is no longer available.", 409);
      await assertNoGitLocks(plan.repository);
      const identity = await inspectWorktreeIdentity(plan.path);
      if (
        identity.branch !== plan.branch
        || identity.head !== plan.head
        || identity.gitDirectory !== plan.gitDirectory
        || identity.device !== plan.device
        || identity.inode !== plan.inode
        || identity.directoryChangeTimeNs !== plan.directoryChangeTimeNs
        || identity.gitMarkerChangeTimeNs !== plan.gitMarkerChangeTimeNs
      ) {
        throw new RepositoryError(
          "The approved worktree checkout was replaced or changed. Removal was cancelled.",
          409,
        );
      }
      await assertRemovableWorktree(plan.path, "The worktree changed after approval. Removal was cancelled.");
      await this.#finalizeRemoval(registry, record);
    });
  }

  /** Active managed worktrees still counting toward the installation limit. */
  async countActiveManaged(): Promise<number> {
    const registry = await this.store.load();
    return countActiveManaged(registry);
  }

  /**
   * Release a managed worktree without deleting conversation history.
   * Uses the same recoverable pending-removal path as approved removal so the
   * checkout stops counting toward the limit even if the final registry write fails.
   * Idempotent when the path is already released or was never managed.
   */
  async releaseManagedPath(pathInput: string): Promise<{
    released: boolean;
    path: string;
    count: number;
  }> {
    return this.#exclusive(pathInput, async () => {
      const registry = await this.store.load();
      const record = await findManagedByPath(registry, pathInput);
      if (!record) {
        return {
          released: false,
          path: pathInput,
          count: countActiveManaged(registry),
        };
      }
      const pathExistsOnDisk = await pathExists(record.path);
      if (!pathExistsOnDisk) {
        await this.#finalizeAbsentRemoval(registry, record);
        return {
          released: true,
          path: record.path,
          count: await this.countActiveManaged(),
        };
      }
      if (record.removalPendingAt) {
        throw new RepositoryError(
          "The pending-removal path exists again. Recovery stopped to preserve a possibly replaced checkout.",
          409,
        );
      }
      await assertNoGitLocks(record.repository);
      const identity = await inspectWorktreeIdentity(record.path);
      if (identity.branch !== record.branch) {
        throw new RepositoryError("The managed worktree branch no longer matches its ownership record.", 409);
      }
      await assertRemovableWorktree(record.path);
      await this.#finalizeRemoval(registry, record);
      return {
        released: true,
        path: record.path,
        count: await this.countActiveManaged(),
      };
    });
  }

  async #finalizeAbsentRemoval(
    registry: ManagedWorktreeRegistry,
    record: ManagedWorktreeRecord,
  ): Promise<void> {
    const ownershipMatches = registry.records.filter((candidate) => (
      !candidate.removedAt
      && (
        candidate.path === record.path
        || (candidate.repository === record.repository && candidate.branch === record.branch)
      )
    ));
    if (ownershipMatches.length !== 1 || ownershipMatches[0]?.id !== record.id) {
      throw new RepositoryError(
        "Managed worktree ownership is ambiguous. Recovery did not change the registry.",
        409,
      );
    }
    const discovered = await discoverWorktrees(record.repository);
    const relocated = discovered.find((worktree) => (
      worktree.path === record.path || worktree.branch === record.branch
    ));
    if (relocated) {
      throw new RepositoryError(
        relocated.path === record.path
          ? "The managed worktree path is still registered by Git. Recovery did not change it."
          : "The managed worktree was moved. Recovery did not remove or release the relocated checkout.",
        409,
      );
    }
    // Re-read and revalidate immediately before committing so a registry
    // replacement outside the shared administration lock cannot be overwritten.
    const current = await this.store.load();
    const currentRecord = current.records.find((candidate) => candidate.id === record.id);
    if (
      !currentRecord
      || currentRecord.removedAt
      || currentRecord.repository !== record.repository
      || currentRecord.path !== record.path
      || currentRecord.branch !== record.branch
      || await pathExists(record.path)
    ) {
      throw new RepositoryError(
        "Managed worktree recovery state changed during inspection. Retry Release.",
        409,
      );
    }
    const currentMatches = current.records.filter((candidate) => (
      !candidate.removedAt
      && (
        candidate.path === record.path
        || (candidate.repository === record.repository && candidate.branch === record.branch)
      )
    ));
    const currentDiscovered = await discoverWorktrees(record.repository);
    if (
      currentMatches.length !== 1
      || currentMatches[0]?.id !== record.id
      || currentDiscovered.some((worktree) => (
        worktree.path === record.path || worktree.branch === record.branch
      ))
    ) {
      throw new RepositoryError(
        "Managed worktree recovery state changed during inspection. Retry Release.",
        409,
      );
    }
    const next = current.records.map((candidate) => (
      candidate.id === record.id
        ? {
            ...candidate,
            removalPendingAt: null,
            removedAt: candidate.removedAt ?? new Date().toISOString(),
          }
        : candidate
    ));
    await this.store.save(next);
    const [pathReturned, discoveredAfterCommit] = await Promise.all([
      pathExists(record.path),
      discoverWorktrees(record.repository),
    ]);
    if (
      pathReturned
      || discoveredAfterCommit.some((worktree) => (
        worktree.path === record.path || worktree.branch === record.branch
      ))
    ) {
      const afterCommit = await this.store.load();
      await this.store.save(afterCommit.records.map((candidate) => (
        candidate.id === record.id
          ? {
              ...candidate,
              removalPendingAt: record.removalPendingAt ?? new Date().toISOString(),
              removedAt: null,
            }
          : candidate
      )));
      throw new RepositoryError(
        "The managed worktree reappeared during recovery. Its pending ownership record was preserved.",
        409,
      );
    }
  }

  async #finalizeRemoval(
    registry: ManagedWorktreeRegistry,
    record: ManagedWorktreeRecord,
  ): Promise<void> {
    const removalPendingAt = new Date().toISOString();
    const pendingRecords = registry.records.map((candidate) => (
      candidate.id === record.id ? { ...candidate, removalPendingAt } : candidate
    ));
    await this.store.save(pendingRecords);
    try {
      await git(
        record.repository,
        ["worktree", "remove", record.path],
        "Git could not remove the worktree. Its branch and files were not otherwise changed.",
      );
    } catch (error) {
      await this.store.save(registry.records).catch(() => undefined);
      throw error;
    }
    try {
      await this.store.save(pendingRecords.map((candidate) => (
        candidate.id === record.id
          ? { ...candidate, removalPendingAt: null, removedAt: new Date().toISOString() }
          : candidate
      )));
    } catch {
      throw new RepositoryError(
        "The checkout was removed, but its ownership record remains in recoverable pending-removal state and no longer counts toward the managed limit.",
        500,
      );
    }
  }

  #consumePlan<T extends WorktreePlan["action"]>(
    id: string,
    action: T,
  ): Extract<WorktreePlan, { action: T }> {
    const plan = this.#plans.get(id);
    this.#plans.delete(id);
    if (!plan || plan.action !== action) throw new RepositoryError("The worktree approval is missing or already used.", 409);
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new RepositoryError("The worktree approval expired. Preview it again.", 409);
    return plan as Extract<WorktreePlan, { action: T }>;
  }

  async #exclusive<T>(_repository: string, operation: () => Promise<T>): Promise<T> {
    if (this.#operationActive) {
      throw new RepositoryError("Another Aldunis Git operation is already active for this installation.", 409);
    }
    this.#operationActive = true;
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        release = await lock(join(this.directory, "worktree-admin"), {
          realpath: false,
          stale: 30_000,
          update: 10_000,
          retries: 0,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
          throw new RepositoryError(
            "Another Aldunis Git operation is already active for this installation.",
            409,
          );
        }
        throw error;
      }
      return await operation();
    } finally {
      try {
        await release?.();
      } finally {
        this.#operationActive = false;
      }
    }
  }
}

async function assertRemovableWorktree(
  path: string,
  changedMessage = "Dirty worktrees cannot be removed.",
): Promise<void> {
  const [changes, ignored] = await Promise.all([
    git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "The worktree state could not be inspected."),
    git(
      path,
      ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"],
      "Ignored worktree files could not be inspected.",
    ),
  ]);
  if (changes.length > 0 || ignored.split("\0").some((entry) => entry.startsWith("!! "))) {
    throw new RepositoryError(changedMessage, 409);
  }
}

async function inspectWorktreeIdentity(path: string): Promise<{
  branch: string;
  head: string;
  gitDirectory: string;
  device: number;
  inode: number;
  directoryChangeTimeNs: string;
  gitMarkerChangeTimeNs: string;
}> {
  const details = await stat(path, { bigint: true }).catch(() => {
    throw new RepositoryError("The managed worktree is missing or inaccessible.", 409);
  });
  const [branch, head, rawGitDirectory, gitMarkerDetails] = await Promise.all([
    git(
      path,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "The managed worktree no longer has an attached branch.",
    ),
    git(path, ["rev-parse", "--verify", "HEAD"], "The managed worktree HEAD is unavailable."),
    git(path, ["rev-parse", "--git-dir"], "The managed worktree Git directory is unavailable."),
    stat(join(path, ".git"), { bigint: true }).catch(() => {
      throw new RepositoryError("The managed worktree Git identity is unavailable.", 409);
    }),
  ]);
  const gitDirectory = await realpath(resolve(path, rawGitDirectory.trim())).catch(() => {
    throw new RepositoryError("The managed worktree Git identity is unavailable.", 409);
  });
  return {
    branch: branch.trim(),
    head: head.trim(),
    gitDirectory,
    device: Number(details.dev),
    inode: Number(details.ino),
    directoryChangeTimeNs: details.ctimeNs.toString(),
    gitMarkerChangeTimeNs: gitMarkerDetails.ctimeNs.toString(),
  };
}

export function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
