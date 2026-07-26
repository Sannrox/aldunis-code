import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RepositoryError } from "./repository.ts";

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export const DIRECTORY_BROWSE_LIMITS = {
  maxDepth: 12,
  maxEntries: 200,
  timeoutMs: 1_500,
  maxConcurrent: 2,
} as const;

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  truncated: boolean;
  limits: typeof DIRECTORY_BROWSE_LIMITS;
}

interface BrowseOptions {
  path?: string;
  includeHidden?: boolean;
  signal?: AbortSignal;
}

interface BrowserOptions {
  roots?: string[];
  limits?: Partial<typeof DIRECTORY_BROWSE_LIMITS>;
}

function isWithin(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function filesystemMessage(error: unknown): { status: number; message: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { status: 404, message: "That directory no longer exists." };
  if (code === "EACCES" || code === "EPERM") {
    return { status: 403, message: "That directory is not accessible." };
  }
  if (code === "ENOTDIR") return { status: 400, message: "The selected path is not a directory." };
  return { status: 400, message: "The directory could not be inspected." };
}

export class DirectoryBrowser {
  readonly limits: typeof DIRECTORY_BROWSE_LIMITS;
  private readonly configuredRoots: string[];
  private active = 0;

  constructor(options: BrowserOptions = {}) {
    this.configuredRoots = options.roots ?? [homedir()];
    this.limits = { ...DIRECTORY_BROWSE_LIMITS, ...options.limits };
  }

  async browse(options: BrowseOptions = {}): Promise<DirectoryListing> {
    if (this.active >= this.limits.maxConcurrent) {
      throw new RepositoryError("Too many directory requests are already active.", 429);
    }
    this.active += 1;
    const operation = this.browseWithinLimits(options);
    operation.then(
      () => { this.active -= 1; },
      () => { this.active -= 1; },
    );
    let timeout: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new RepositoryError("Directory browsing took too long.", 408)),
          Math.max(0, this.limits.timeoutMs),
        );
      });
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new RepositoryError("Directory browsing was cancelled.", 499));
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([operation, deadline, cancelled]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async browseWithinLimits(options: BrowseOptions): Promise<DirectoryListing> {
    const startedAt = Date.now();
    const roots = await Promise.all(this.configuredRoots.map((root) => realpath(root)));
    const requested = options.path ? resolve(expandUserPath(options.path)) : roots[0];
    const checkBudget = () => {
      if (options.signal?.aborted) {
        throw new RepositoryError("Directory browsing was cancelled.", 499);
      }
      if (Date.now() - startedAt > this.limits.timeoutMs) {
        throw new RepositoryError("Directory browsing took too long.", 408);
      }
    };

    checkBudget();
    try {
      const requestedDetails = await lstat(requested);
      if (requestedDetails.isSymbolicLink()) {
        throw new RepositoryError("Symlinked directories are not available in the picker.", 403);
      }
      if (!requestedDetails.isDirectory()) {
        throw new RepositoryError("The selected path is not a directory.");
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      const failure = filesystemMessage(error);
      throw new RepositoryError(failure.message, failure.status);
    }

    const canonical = await realpath(requested);
    const root = roots.find((candidate) => isWithin(candidate, canonical));
    if (!root) {
      throw new RepositoryError("Directory browsing is limited to permitted local roots.", 403);
    }
    const depth = relative(root, canonical).split(sep).filter(Boolean).length;
    if (depth > this.limits.maxDepth) {
      throw new RepositoryError(`Directory browsing is limited to ${this.limits.maxDepth} levels.`, 403);
    }
    const [rootDetails, currentDetails] = await Promise.all([stat(root), stat(canonical)]);
    if (rootDetails.dev !== currentDetails.dev) {
      throw new RepositoryError("Mounted and network locations are not available in the picker.", 403);
    }

    const entries: DirectoryEntry[] = [];
    let truncated = false;
    let directory;
    try {
      directory = await opendir(canonical);
      for await (const entry of directory) {
        checkBudget();
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const hidden = entry.name.startsWith(".");
        if (hidden && !options.includeHidden) continue;
        if (entries.length >= this.limits.maxEntries) {
          truncated = true;
          break;
        }
        entries.push({
          name: entry.name,
          path: resolve(canonical, entry.name),
          hidden,
        });
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      const failure = filesystemMessage(error);
      throw new RepositoryError(failure.message, failure.status);
    } finally {
      await directory?.close().catch(() => undefined);
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    const parentCandidate = resolve(canonical, "..");
    return {
      path: canonical,
      parent: canonical === root || !isWithin(root, parentCandidate) ? null : parentCandidate,
      entries,
      truncated,
      limits: this.limits,
    };
  }
}
