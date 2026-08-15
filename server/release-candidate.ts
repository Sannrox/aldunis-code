import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { RepositoryError } from "./repository.ts";

const execFileAsync = promisify(execFile);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_DOMAIN = Buffer.from("ALDUNIS-SOURCE-TREE-V1\0", "ascii");
const CANDIDATE_DOMAIN = Buffer.from("ALDUNIS-DELIVERY-CANDIDATE-V1\0", "ascii");
const GIT_BATCH_IDLE_TIMEOUT_MS = 20_000;
const MAX_GIT_BATCH_HEADER_BYTES = 256;
const MAX_GIT_BATCH_STDERR_BYTES = 64 * 1024;
export const MAX_ARTIFACT_TREE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_TREE_BATCH_ENTRIES = 256;
export const MAX_GIT_TREE_RECORD_BYTES = 64 * 1024;
const ARTIFACT_FILE_READ_BUFFER_BYTES = 256 * 1024;
export const MAX_RELEASE_PACKAGE_MANIFEST_BYTES = 256 * 1024;
export const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;

export interface ReleaseArtifactDescriptor {
  media_type: string;
  size: number;
  digest: string;
  location_class: "local" | "oci";
}

export interface AldunisDeliveryCandidate {
  schema: "aldunis.delivery-candidate/v1";
  repository: { authority: "git"; id: string };
  commit: { algorithm: "sha1" | "sha256"; oid: string };
  source_tree_digest: string;
  manifest: { path: string; digest: string };
  artifacts: ReleaseArtifactDescriptor[];
  build_definition_digest: string;
}

export interface ChiseiSoftwareReleaseCandidate {
  revision: string;
  source_tree_digest: string;
  manifest_digest: string;
  artifact_reference: string;
  artifact_digest: string;
  build_definition_digest: string;
}

export interface PreparedReleaseCandidate {
  identity: string;
  document: AldunisDeliveryCandidate;
  chisei: ChiseiSoftwareReleaseCandidate;
  product: string;
  version: string;
  release: string;
  manifestPath: string;
  build: {
    adapter: "npm";
    commands: Array<{
      id: "install" | "build" | "test";
      executable: "npm";
      args: string[];
      declared: string;
    }>;
    definitionDigest: string;
  };
}

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function length64(value: number, littleEndian = false): Buffer {
  const output = Buffer.alloc(8);
  if (littleEndian) output.writeBigUInt64LE(BigInt(value));
  else output.writeBigUInt64BE(BigInt(value));
  return output;
}

function hashBytes(hash: ReturnType<typeof createHash>, value: Buffer): void {
  hash.update(length64(value.length, true));
  hash.update(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RepositoryError("The delivery candidate contains an unsupported number.", 409);
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new RepositoryError("The delivery candidate contains an unsupported value.", 409);
}

function normalizedText(value: unknown, field: string, maximum = 1_024): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex -- candidate text rejects ASCII control bytes.
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RepositoryError(`${field} is missing or invalid.`, 409);
  }
  if (value !== value.normalize("NFC")) {
    throw new RepositoryError(`${field} must use Unicode NFC.`, 409);
  }
  return value;
}

function safeRelativePath(value: unknown, field: string): string {
  const path = normalizedText(value, field).replaceAll("\\", "/");
  if (
    path === "." ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new RepositoryError(`${field} must be a canonical repository-relative path.`, 409);
  }
  return path;
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function git(worktree: string, args: string[], encoding: BufferEncoding | "buffer" = "utf8") {
  try {
    return await execFileAsync("git", ["-C", worktree, ...args], {
      encoding,
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch {
    throw new RepositoryError("The committed repository state could not be inspected.", 409);
  }
}

class GitBatchReader {
  readonly #iterator: AsyncIterator<Buffer | string>;
  readonly #onActivity: () => void;
  #buffer = Buffer.alloc(0);
  #ended = false;

  constructor(stream: AsyncIterable<Buffer | string>, onActivity: () => void = () => undefined) {
    this.#iterator = stream[Symbol.asyncIterator]();
    this.#onActivity = onActivity;
  }

  async #fill(): Promise<boolean> {
    while (!this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) {
        this.#ended = true;
        return false;
      }
      this.#onActivity();
      const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
      if (chunk.length === 0) continue;
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      return true;
    }
    return false;
  }

  async line(): Promise<string> {
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline !== -1) {
        if (newline > MAX_GIT_BATCH_HEADER_BYTES) {
          throw new Error("Git batch header exceeds its framing limit.");
        }
        const line = this.#buffer.subarray(0, newline).toString("ascii");
        this.#buffer = this.#buffer.subarray(newline + 1);
        return line;
      }
      if (this.#buffer.length > MAX_GIT_BATCH_HEADER_BYTES || !(await this.#fill())) {
        throw new Error("Git batch output ended before a complete header.");
      }
    }
  }

  async bytes(length: number, consume: (chunk: Buffer) => void): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#buffer.length === 0 && !(await this.#fill())) {
        throw new Error("Git batch output ended inside an object.");
      }
      const count = Math.min(remaining, this.#buffer.length);
      consume(this.#buffer.subarray(0, count));
      this.#buffer = this.#buffer.subarray(count);
      remaining -= count;
    }
  }

  async separator(): Promise<void> {
    if (this.#buffer.length === 0 && !(await this.#fill())) {
      throw new Error("Git batch output omitted its object separator.");
    }
    if (this.#buffer[0] !== 0x0a) throw new Error("Git batch output has an invalid separator.");
    this.#buffer = this.#buffer.subarray(1);
  }

  async end(): Promise<void> {
    if (this.#buffer.length > 0 || (await this.#fill())) {
      throw new Error("Git batch output contains unexpected trailing data.");
    }
  }
}

type SourceTreeBlob = { oid: string };
type SourceTreeEntry = SourceTreeBlob & { path: Buffer; mode: Buffer };

export async function* consumeGitTreeRecords(
  stream: AsyncIterable<Buffer | string>,
  onActivity: () => void = () => undefined,
  onSuspend: () => void = () => undefined,
): AsyncGenerator<SourceTreeEntry> {
  let pending = Buffer.alloc(0);
  let previousPath: Buffer | null = null;
  for await (const rawChunk of stream) {
    onActivity();
    let chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
    while (chunk.length > 0) {
      const delimiter = chunk.indexOf(0);
      if (delimiter === -1) {
        if (pending.length + chunk.length > MAX_GIT_TREE_RECORD_BYTES) {
          throw new RepositoryError("Delivery candidate tree entry is too large.", 409);
        }
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        break;
      }
      const segment = chunk.subarray(0, delimiter);
      if (pending.length + segment.length > MAX_GIT_TREE_RECORD_BYTES) {
        throw new RepositoryError("Delivery candidate tree entry is too large.", 409);
      }
      const bytes =
        pending.length === 0
          ? segment
          : Buffer.concat([pending, segment], pending.length + segment.length);
      pending = Buffer.alloc(0);
      chunk = chunk.subarray(delimiter + 1);
      if (bytes.length === 0) continue;
      const tab = bytes.indexOf(0x09);
      const metadata = bytes.subarray(0, tab).toString("ascii").split(" ");
      const path = bytes.subarray(tab + 1);
      if (tab < 0 || metadata.length !== 3 || metadata[1] !== "blob") {
        throw new RepositoryError(
          "Delivery candidates cannot contain submodules or unsupported Git entries.",
          409,
        );
      }
      if (previousPath && Buffer.compare(previousPath, path) >= 0) {
        throw new RepositoryError("Delivery candidate tree paths are not canonical.", 409);
      }
      if (!["100644", "100755"].includes(metadata[0])) {
        throw new RepositoryError(
          "Delivery candidates cannot contain symlinks or unsupported Git modes.",
          409,
        );
      }
      const text = path.toString("utf8");
      if (
        !Buffer.from(text, "utf8").equals(path) ||
        text !== text.normalize("NFC") ||
        // eslint-disable-next-line no-control-regex -- canonical paths reject ASCII control bytes.
        /[\u0000-\u001f\u007f]/u.test(text)
      ) {
        throw new RepositoryError(
          "Delivery candidates require canonical UTF-8 tracked paths.",
          409,
        );
      }
      previousPath = path;
      onSuspend();
      try {
        yield { path, mode: Buffer.from(metadata[0], "ascii"), oid: metadata[2] };
      } finally {
        onActivity();
      }
    }
  }
  if (pending.length > 0) {
    throw new RepositoryError("Delivery candidate tree output is incomplete.", 409);
  }
}

interface GitBlobBatchOptions {
  maximumBytes?: number;
  consumeChunk?: (chunk: Buffer) => void;
  oversized?: () => never;
}

export async function consumeGitBlobBatch(
  stream: AsyncIterable<Buffer | string>,
  entries: SourceTreeBlob[],
  consume: (digest: Buffer) => void,
  onActivity: () => void = () => undefined,
  options: GitBlobBatchOptions = {},
): Promise<void> {
  const reader = new GitBatchReader(stream, onActivity);
  for (const entry of entries) {
    const header = await reader.line();
    const match = header.match(/^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/);
    const size = match ? Number(match[2]) : Number.NaN;
    if (!match || match[1] !== entry.oid || !Number.isSafeInteger(size)) {
      throw new Error("Git batch output does not match the requested blob.");
    }
    if (options.maximumBytes !== undefined && size > options.maximumBytes) {
      options.oversized?.();
      throw new Error("Git batch object exceeds its admitted size.");
    }
    const blobHash = createHash("sha256");
    await reader.bytes(size, (chunk) => {
      blobHash.update(chunk);
      options.consumeChunk?.(chunk);
    });
    await reader.separator();
    consume(blobHash.digest());
  }
  await reader.end();
}

async function hashSourceTreeBlobs<T extends SourceTreeBlob>(
  worktree: string,
  entries: Iterable<T> | AsyncIterable<T>,
  consume: (entry: T, digest: Buffer) => void,
  options: GitBlobBatchOptions = {},
): Promise<void> {
  const child = spawn("git", ["-C", worktree, "cat-file", "--batch"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timedOut = false;
  let timer: NodeJS.Timeout;
  const resetIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_BATCH_IDLE_TIMEOUT_MS);
    timer.unref();
  };
  resetIdleTimer();
  const exit = new Promise<{ code: number | null; error: Error | null }>((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, error }));
    child.once("close", (code) => resolveExit({ code, error: null }));
  });
  const stderr = (async () => {
    const chunks: Buffer[] = [];
    let retained = 0;
    for await (const rawChunk of child.stderr) {
      resetIdleTimer();
      if (retained >= MAX_GIT_BATCH_STDERR_BYTES) continue;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const bounded = chunk.subarray(0, MAX_GIT_BATCH_STDERR_BYTES - retained);
      chunks.push(bounded);
      retained += bounded.length;
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
  try {
    const reader = new GitBatchReader(child.stdout, resetIdleTimer);
    let batch: T[] = [];
    const consumeBatch = async () => {
      const current = batch;
      batch = [];
      const write = async () => {
        for (const entry of current) {
          resetIdleTimer();
          if (!child.stdin.write(`${entry.oid}\n`)) await once(child.stdin, "drain");
        }
      };
      const read = async () => {
        for (const entry of current) {
          const header = await reader.line();
          const match = header.match(/^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/);
          const size = match ? Number(match[2]) : Number.NaN;
          if (!match || match[1] !== entry.oid || !Number.isSafeInteger(size)) {
            throw new Error("Git batch output does not match the requested blob.");
          }
          if (options.maximumBytes !== undefined && size > options.maximumBytes) {
            options.oversized?.();
            throw new Error("Git batch object exceeds its admitted size.");
          }
          const blobHash = createHash("sha256");
          await reader.bytes(size, (chunk) => {
            blobHash.update(chunk);
            options.consumeChunk?.(chunk);
          });
          await reader.separator();
          consume(entry, blobHash.digest());
        }
      };
      await Promise.all([write(), read()]);
    };
    for await (const entry of entries) {
      batch.push(entry);
      if (batch.length === MAX_SOURCE_TREE_BATCH_ENTRIES) await consumeBatch();
    }
    if (batch.length > 0) await consumeBatch();
    child.stdin.end();
    await finished(child.stdin);
    await reader.end();
    const outcome = await exit;
    const errorText = await stderr;
    if (timedOut || outcome.error || outcome.code !== 0) {
      throw new Error(errorText || outcome.error?.message || "Git batch process failed.");
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    await exit;
    await stderr;
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("The committed repository state could not be inspected.", 409);
  } finally {
    clearTimeout(timer);
  }
}

async function assertCommittedPath(worktree: string, path: string, label: string): Promise<void> {
  const tracked = (await git(worktree, ["ls-files", "-z", "--", path])).stdout as string;
  if (!tracked) {
    throw new RepositoryError(`${label} must be tracked by the candidate commit.`, 409);
  }
  const ignored = (
    await git(worktree, [
      "status",
      "--porcelain=v1",
      "-z",
      "--ignored=matching",
      "--untracked-files=all",
      "--",
      path,
    ])
  ).stdout as string;
  if (ignored.split("\0").some((entry) => entry.startsWith("!! "))) {
    throw new RepositoryError(`${label} cannot contain ignored local inputs.`, 409);
  }
}

function canonicalRepositoryIdentity(raw: string): string {
  const value = normalizedText(raw.trim(), "The canonical repository identity", 2_048);
  if (/[?#]/.test(value)) {
    throw new RepositoryError("The repository remote must not contain a query or fragment.", 409);
  }
  const scp = value.match(/^(?:([^@]+)@)?([^:]+):(.+)$/);
  if (scp && !value.includes("://")) {
    const user = scp[1] ? `${scp[1]}@` : "";
    return `ssh://${user}${scp[2]}/${scp[3]}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryError("A canonical credential-free Git remote is required.", 409);
  }
  if (
    !["https:", "http:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RepositoryError("A canonical credential-free Git remote is required.", 409);
  }
  if (url.username && url.protocol !== "ssh:") {
    throw new RepositoryError("The Git remote must not contain credentials.", 409);
  }
  return url.toString().replace(/\/$/, "");
}

export async function sourceTreeDigest(worktree: string): Promise<string> {
  const child = spawn("git", ["-C", worktree, "ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let suspended = false;
  let timer: NodeJS.Timeout;
  const resetIdleTimer = () => {
    clearTimeout(timer);
    if (suspended) return;
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_BATCH_IDLE_TIMEOUT_MS);
    timer.unref();
  };
  const resumeIdleTimer = () => {
    suspended = false;
    resetIdleTimer();
  };
  const pauseIdleTimer = () => {
    suspended = true;
    clearTimeout(timer);
  };
  resetIdleTimer();
  const exit = new Promise<{ code: number | null; error: Error | null }>((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, error }));
    child.once("close", (code) => resolveExit({ code, error: null }));
  });
  const stderr = (async () => {
    const chunks: Buffer[] = [];
    let retained = 0;
    for await (const rawChunk of child.stderr) {
      resetIdleTimer();
      if (retained >= MAX_GIT_BATCH_STDERR_BYTES) continue;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const bounded = chunk.subarray(0, MAX_GIT_BATCH_STDERR_BYTES - retained);
      chunks.push(bounded);
      retained += bounded.length;
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
  const hash = createHash("sha256").update(SOURCE_DOMAIN);
  try {
    await hashSourceTreeBlobs(
      worktree,
      consumeGitTreeRecords(child.stdout, resumeIdleTimer, pauseIdleTimer),
      (entry, blobDigest) => {
        hash.update(length64(entry.path.length));
        hash.update(entry.path);
        hash.update(length64(entry.mode.length));
        hash.update(entry.mode);
        hash.update(blobDigest);
      },
    );
    const outcome = await exit;
    const errorText = await stderr;
    if (timedOut || outcome.error || outcome.code !== 0) {
      throw new Error(errorText || outcome.error?.message || "Git tree process failed.");
    }
    return `sha256:${hash.digest("hex")}`;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    await exit;
    await stderr;
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("The committed repository state could not be inspected.", 409);
  } finally {
    clearTimeout(timer);
  }
}

async function hashArtifactPath(
  hash: ReturnType<typeof createHash>,
  root: string,
  path: string,
  committedTree: CommittedArtifactTree,
  directoryPath: string,
): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length === 0) {
    throw new RepositoryError(
      "Tenkai artifact inputs cannot contain uncommitted empty directories.",
      409,
    );
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  const committedEntries = committedTree.get(directoryPath);
  if (!committedEntries) {
    throw new RepositoryError(
      "Tenkai artifact inputs must match their committed directory entries.",
      409,
    );
  }
  if (committedEntries.size !== entries.length) {
    throw new RepositoryError(
      "Tenkai artifact inputs must match their committed directory entries.",
      409,
    );
  }
  hash.update(length64(entries.length, true));
  let size = 0;
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    const relativePath = relative(root, child).split(sep).join("/");
    const relativeBytes = Buffer.from(relativePath, "utf8");
    if (relativePath !== relativePath.normalize("NFC")) {
      throw new RepositoryError("Tenkai artifact inputs require canonical UTF-8 paths.", 409);
    }
    const metadata = await lstat(child);
    hashBytes(hash, relativeBytes);
    if (metadata.isSymbolicLink()) {
      throw new RepositoryError("Tenkai artifact inputs cannot contain symlinks.", 409);
    }
    const committed = committedEntries.get(entry.name);
    if (
      !committed ||
      (metadata.isDirectory() && committed.type !== "tree") ||
      (metadata.isFile() && committed.type !== "blob")
    ) {
      throw new RepositoryError(
        "Tenkai artifact inputs must match their committed directory entries.",
        409,
      );
    }
    const permissions = Buffer.alloc(4);
    permissions.writeUInt32LE(committed.mode);
    hash.update(permissions);
    if (metadata.isDirectory()) {
      hashBytes(hash, Buffer.from("dir"));
      size += await hashArtifactPath(
        hash,
        root,
        child,
        committedTree,
        directoryPath ? `${directoryPath}/${entry.name}` : entry.name,
      );
    } else if (metadata.isFile()) {
      hashBytes(hash, Buffer.from("file"));
      size += await hashArtifactFile(hash, child);
    } else {
      throw new RepositoryError("Tenkai artifact inputs contain an unsupported entry.", 409);
    }
  }
  return size;
}

export interface ArtifactFileHandle {
  close(): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<BigIntStats>;
}

export interface ArtifactFileOperations {
  open(path: string): Promise<ArtifactFileHandle>;
  lstat(path: string): Promise<BigIntStats>;
}

const artifactFileOperations: ArtifactFileOperations = {
  open: async (path) => {
    const handle = await open(path, "r");
    return {
      close: () => handle.close(),
      read: async (buffer, offset, length, position) => {
        const { bytesRead } = await handle.read(buffer, offset, length, position);
        return { bytesRead };
      },
      stat: () => handle.stat({ bigint: true }),
    };
  },
  lstat: (path) => lstat(path, { bigint: true }),
};

function sameArtifactFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

interface StableFileMessages {
  changed: string;
  close: string;
}

async function consumeStableFile(
  path: string,
  operations: ArtifactFileOperations,
  messages: StableFileMessages,
  consumeSize: (size: number) => void,
  consumeChunk: (chunk: Buffer) => void,
): Promise<number> {
  let handle: ArtifactFileHandle | null = null;
  try {
    handle = await operations.open(path);
    const initial = await handle.stat();
    const initialPath = await operations.lstat(path);
    if (
      !initial.isFile() ||
      !sameArtifactFile(initial, initialPath) ||
      initial.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("unstable file");
    }
    const size = Number(initial.size);
    consumeSize(size);
    const buffer = Buffer.allocUnsafe(ARTIFACT_FILE_READ_BUFFER_BYTES);
    let position = 0;
    while (position < size) {
      const requested = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error("truncated file");
      consumeChunk(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const final = await handle.stat();
    const finalPath = await operations.lstat(path);
    if (!sameArtifactFile(initial, final) || !sameArtifactFile(initial, finalPath)) {
      throw new Error("changed file");
    }
    const completedHandle = handle;
    handle = null;
    try {
      await completedHandle.close();
    } catch {
      throw new RepositoryError(messages.close, 409);
    }
    return size;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Cleanup must not replace the primary file-stability failure.
      }
    }
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError(messages.changed, 409);
  }
}

export async function hashArtifactFile(
  hash: ReturnType<typeof createHash>,
  path: string,
  operations: ArtifactFileOperations = artifactFileOperations,
): Promise<number> {
  return consumeStableFile(
    path,
    operations,
    {
      changed: "A Tenkai artifact input changed while it was hashed.",
      close: "A Tenkai artifact input could not be closed after hashing.",
    },
    (size) => hash.update(length64(size, true)),
    (chunk) => hash.update(chunk),
  );
}

export async function hashReleaseLockFile(
  path: string,
  operations: ArtifactFileOperations = artifactFileOperations,
): Promise<string> {
  const hash = createHash("sha256");
  await consumeStableFile(
    path,
    operations,
    {
      changed: "The root package-lock.json changed while it was hashed.",
      close: "The root package-lock.json could not be closed after hashing.",
    },
    () => undefined,
    (chunk) => hash.update(chunk),
  );
  return `sha256:${hash.digest("hex")}`;
}

async function readBoundedStableFile(
  path: string,
  maximum: number,
  label: string,
  operations: ArtifactFileOperations,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await consumeStableFile(
    path,
    operations,
    {
      changed: `${label} changed while it was read.`,
      close: `${label} could not be closed after reading.`,
    },
    (size) => {
      if (size > maximum) {
        throw new RepositoryError(`${label} must be at most ${maximum / 1024} KiB.`, 409);
      }
    },
    (chunk) => chunks.push(Buffer.from(chunk)),
  );
  return Buffer.concat(chunks);
}

export async function readReleasePackageManifest(
  path: string,
  operations: ArtifactFileOperations = artifactFileOperations,
): Promise<string> {
  return (
    await readBoundedStableFile(
      path,
      MAX_RELEASE_PACKAGE_MANIFEST_BYTES,
      "The root package.json",
      operations,
    )
  ).toString("utf8");
}

export async function readCommittedReleaseManifest(
  worktree: string,
  path: string,
): Promise<Buffer> {
  const tree = (await git(worktree, ["ls-tree", "-z", "--full-tree", "HEAD", "--", path], "buffer"))
    .stdout as Buffer;
  const tab = tree.indexOf(0x09);
  const metadata = tree.subarray(0, tab).toString("ascii").split(" ");
  const listedPath = tree
    .subarray(tab + 1, tree.length - (tree.at(-1) === 0 ? 1 : 0))
    .toString("utf8");
  if (
    tab < 0 ||
    metadata.length !== 3 ||
    metadata[1] !== "blob" ||
    !["100644", "100755"].includes(metadata[0]) ||
    listedPath !== path
  ) {
    throw new RepositoryError(
      "The selected Tenkai manifest must be a committed regular file.",
      409,
    );
  }
  const chunks: Buffer[] = [];
  await hashSourceTreeBlobs(worktree, [{ oid: metadata[2] }], () => undefined, {
    maximumBytes: MAX_RELEASE_MANIFEST_BYTES,
    consumeChunk: (chunk) => chunks.push(Buffer.from(chunk)),
    oversized: () => {
      throw new RepositoryError(
        `The selected Tenkai manifest must be at most ${MAX_RELEASE_MANIFEST_BYTES / 1024} KiB.`,
        409,
      );
    },
  });
  return Buffer.concat(chunks);
}

async function committedArtifactMode(
  worktree: string,
  path: string,
  directory: boolean,
): Promise<number> {
  if (directory) return 0o755;
  const relativePath = relative(worktree, path).split(sep).join("/");
  const tree = (
    await git(worktree, ["ls-tree", "-z", "--full-tree", "HEAD", "--", relativePath], "buffer")
  ).stdout as Buffer;
  const tab = tree.indexOf(0x09);
  const metadata = tree.subarray(0, tab).toString("ascii").split(" ");
  const listedPath = tree
    .subarray(tab + 1, tree.length - (tree.at(-1) === 0 ? 1 : 0))
    .toString("utf8");
  if (
    tab < 0 ||
    metadata.length !== 3 ||
    metadata[1] !== "blob" ||
    !["100644", "100755"].includes(metadata[0]) ||
    listedPath !== relativePath
  ) {
    throw new RepositoryError("Tenkai artifact files must use a committed regular-file mode.", 409);
  }
  return metadata[0] === "100755" ? 0o755 : 0o644;
}

type CommittedArtifactDirectoryEntry = {
  mode: number;
  type: "blob" | "tree";
};

type CommittedArtifactTree = Map<string, Map<string, CommittedArtifactDirectoryEntry>>;

export async function committedArtifactTreeEntries(
  worktree: string,
  path: string,
  command = "git",
  timeoutMs = GIT_BATCH_IDLE_TIMEOUT_MS,
  maximumBytes = MAX_ARTIFACT_TREE_BYTES,
): Promise<CommittedArtifactTree> {
  const relativePath = relative(worktree, path).split(sep).join("/");
  const child = spawn(
    command,
    ["-C", worktree, "ls-tree", "-r", "-t", "-z", relativePath ? `HEAD:${relativePath}` : "HEAD:"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();
  const exit = new Promise<{ code: number | null; error: Error | null }>((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, error }));
    child.once("close", (code) => resolveExit({ code, error: null }));
  });
  const stderr = (async () => {
    const chunks: Buffer[] = [];
    let retained = 0;
    for await (const rawChunk of child.stderr) {
      if (retained >= MAX_GIT_BATCH_STDERR_BYTES) continue;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const bounded = chunk.subarray(0, MAX_GIT_BATCH_STDERR_BYTES - retained);
      chunks.push(bounded);
      retained += bounded.length;
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
  try {
    const chunks: Buffer[] = [];
    let retained = 0;
    for await (const rawChunk of child.stdout) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (retained + chunk.length > maximumBytes) {
        throw new Error("Committed artifact tree output exceeds its byte limit.");
      }
      chunks.push(chunk);
      retained += chunk.length;
    }
    const outcome = await exit;
    const errorText = await stderr;
    if (timedOut || outcome.error || outcome.code !== 0) {
      throw new Error(errorText || outcome.error?.message || "Git artifact tree process failed.");
    }
    return parseCommittedArtifactTreeEntries(Buffer.concat(chunks, retained));
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    await exit;
    await stderr;
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("The committed artifact tree could not be inspected.", 409);
  } finally {
    clearTimeout(timer);
  }
}

export function parseCommittedArtifactTreeEntries(tree: Buffer): CommittedArtifactTree {
  const directories: CommittedArtifactTree = new Map([["", new Map()]]);
  let offset = 0;
  while (offset < tree.length) {
    const end = tree.indexOf(0, offset);
    if (end < 0) {
      throw new RepositoryError("Committed artifact tree output is incomplete.", 409);
    }
    if (end - offset > MAX_GIT_TREE_RECORD_BYTES) {
      throw new RepositoryError("A committed artifact tree entry is too large.", 409);
    }
    const bytes = tree.subarray(offset, end);
    offset = end + 1;
    if (bytes.length === 0) continue;
    const tab = bytes.indexOf(0x09);
    const metadata = bytes.subarray(0, tab).toString("ascii").split(" ");
    const pathBytes = bytes.subarray(tab + 1);
    const entryPath = pathBytes.toString("utf8");
    const parts = entryPath.split("/");
    const name = parts.at(-1) ?? "";
    const parent = parts.slice(0, -1).join("/");
    const type = metadata[1];
    const mode = metadata[0];
    let entries = directories.get(parent);
    if (!entries) {
      entries = new Map();
      directories.set(parent, entries);
    }
    if (
      tab < 0 ||
      metadata.length !== 3 ||
      !Buffer.from(entryPath, "utf8").equals(pathBytes) ||
      entryPath !== entryPath.normalize("NFC") ||
      parts.some((part) => !part || part === "." || part === "..") ||
      // eslint-disable-next-line no-control-regex -- canonical paths reject ASCII control bytes.
      /[\u0000-\u001f\u007f]/u.test(entryPath) ||
      !(
        (type === "blob" && ["100644", "100755"].includes(mode)) ||
        (type === "tree" && mode === "040000")
      ) ||
      entries.has(name)
    ) {
      throw new RepositoryError("Committed artifact tree entries are not canonical.", 409);
    }
    entries.set(name, {
      mode: type === "tree" || mode === "100755" ? 0o755 : 0o644,
      type,
    });
    if (type === "tree" && !directories.has(entryPath)) directories.set(entryPath, new Map());
  }
  for (const directory of directories.keys()) {
    if (!directory) continue;
    const parts = directory.split("/");
    const name = parts.pop() ?? "";
    const parent = parts.join("/");
    if (directories.get(parent)?.get(name)?.type !== "tree") {
      throw new RepositoryError("Committed artifact tree entries are not canonical.", 409);
    }
  }
  return directories;
}

export function parseCommittedArtifactDirectoryEntries(
  tree: Buffer,
): Map<string, CommittedArtifactDirectoryEntry> {
  const entries = new Map<string, CommittedArtifactDirectoryEntry>();
  let offset = 0;
  while (offset < tree.length) {
    const end = tree.indexOf(0, offset);
    if (end < 0) {
      throw new RepositoryError("Committed artifact directory output is incomplete.", 409);
    }
    if (end - offset > MAX_GIT_TREE_RECORD_BYTES) {
      throw new RepositoryError("A committed artifact directory entry is too large.", 409);
    }
    const bytes = tree.subarray(offset, end);
    offset = end + 1;
    if (bytes.length === 0) continue;
    const tab = bytes.indexOf(0x09);
    const metadata = bytes.subarray(0, tab).toString("ascii").split(" ");
    const pathBytes = bytes.subarray(tab + 1);
    const name = pathBytes.toString("utf8");
    const type = metadata[1];
    const mode = metadata[0];
    if (
      tab < 0 ||
      metadata.length !== 3 ||
      !Buffer.from(name, "utf8").equals(pathBytes) ||
      name !== name.normalize("NFC") ||
      name.includes("/") ||
      // eslint-disable-next-line no-control-regex -- canonical paths reject ASCII control bytes.
      /[\u0000-\u001f\u007f]/u.test(name) ||
      !(
        (type === "blob" && ["100644", "100755"].includes(mode)) ||
        (type === "tree" && mode === "040000")
      ) ||
      entries.has(name)
    ) {
      throw new RepositoryError("Committed artifact directory entries are not canonical.", 409);
    }
    entries.set(name, {
      mode: type === "tree" || mode === "100755" ? 0o755 : 0o644,
      type,
    });
  }
  return entries;
}

async function artifactDigest(
  worktree: string,
  manifestAbsolute: string,
  manifest: TOML.JsonMap,
): Promise<{ digest: string; size: number }> {
  const deploy = (manifest.deploy ?? {}) as TOML.JsonMap;
  const workdirValue = deploy.workdir === undefined ? "." : deploy.workdir;
  const workdir =
    workdirValue === "."
      ? dirname(manifestAbsolute)
      : resolve(dirname(manifestAbsolute), safeRelativePath(workdirValue, "deploy.workdir"));
  const canonicalWorktree = await realpath(worktree);
  const canonicalWorkdir = await realpath(workdir).catch(() => {
    throw new RepositoryError("The Tenkai deploy workdir is unavailable.", 409);
  });
  if (!within(canonicalWorktree, canonicalWorkdir)) {
    throw new RepositoryError("The Tenkai deploy workdir escapes the selected worktree.", 403);
  }
  const rawInputs = deploy.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.some((item) => typeof item !== "string")) {
    throw new RepositoryError("The Tenkai manifest has incompatible deploy inputs.", 409);
  }
  const inputs = rawInputs.map((item) => safeRelativePath(item, "A Tenkai deploy input")).sort();
  if (new Set(inputs).size !== inputs.length) {
    throw new RepositoryError("The Tenkai manifest contains duplicate deploy inputs.", 409);
  }
  const hash = createHash("sha256").update(length64(inputs.length, true));
  let size = 0;
  for (const input of inputs) {
    const path = resolve(canonicalWorkdir, input);
    if (!within(canonicalWorkdir, path)) {
      throw new RepositoryError("A Tenkai deploy input escapes its workdir.", 403);
    }
    const metadata = await lstat(path).catch(() => {
      throw new RepositoryError(`Tenkai deploy input ${input} is unavailable.`, 409);
    });
    await assertCommittedPath(
      worktree,
      relative(canonicalWorktree, path).split(sep).join("/"),
      `Tenkai deploy input ${input}`,
    );
    if (metadata.isSymbolicLink()) {
      throw new RepositoryError("Tenkai deploy inputs cannot be symlinks.", 409);
    }
    const permissions = Buffer.alloc(4);
    permissions.writeUInt32LE(
      await committedArtifactMode(canonicalWorktree, path, metadata.isDirectory()),
    );
    hash.update(permissions);
    hashBytes(hash, Buffer.from(input));
    if (metadata.isDirectory()) {
      hashBytes(hash, Buffer.from("dir"));
      const committedTree = await committedArtifactTreeEntries(canonicalWorktree, path);
      size += await hashArtifactPath(hash, canonicalWorkdir, path, committedTree, "");
    } else if (metadata.isFile()) {
      hashBytes(hash, Buffer.from("file"));
      size += await hashArtifactFile(hash, path);
    } else {
      throw new RepositoryError("A Tenkai deploy input has an unsupported type.", 409);
    }
  }
  return { digest: `sha256:${hash.digest("hex")}`, size };
}

async function buildDefinition(worktree: string): Promise<PreparedReleaseCandidate["build"]> {
  const packagePath = resolve(worktree, "package.json");
  await assertCommittedPath(worktree, "package.json", "The root package.json");
  await assertCommittedPath(worktree, "package-lock.json", "The root package-lock.json");
  const raw = await readReleasePackageManifest(packagePath).catch((error: unknown) => {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("Version 1 delivery requires a committed root package.json.", 409);
  });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RepositoryError("The root package.json is invalid.", 409);
  }
  const scripts = (value as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new RepositoryError(
      "Version 1 delivery requires declared npm build and test scripts.",
      409,
    );
  }
  const build = normalizedText(
    (scripts as Record<string, unknown>).build,
    "The npm build script",
    2_000,
  );
  const test = normalizedText(
    (scripts as Record<string, unknown>).test,
    "The npm test script",
    2_000,
  );
  const lockDigest = await hashReleaseLockFile(resolve(worktree, "package-lock.json")).catch(
    (error: unknown) => {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("Version 1 delivery requires a committed package-lock.json.", 409);
    },
  );
  const definition = {
    schema: "aldunis.build-definition/v1",
    adapter: "npm",
    lock_digest: lockDigest,
    install: {
      executable: "npm",
      args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    },
    scripts: { build, test },
  };
  return {
    adapter: "npm",
    commands: [
      {
        id: "install",
        executable: "npm",
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        declared: "npm ci --ignore-scripts --no-audit --no-fund",
      },
      { id: "build", executable: "npm", args: ["run", "build"], declared: build },
      { id: "test", executable: "npm", args: ["test"], declared: test },
    ],
    definitionDigest: sha256(canonicalJson(definition)),
  };
}

export async function prepareReleaseCandidate(
  repository: string,
  worktree: string,
  manifestPath: string,
): Promise<PreparedReleaseCandidate> {
  const clean = (await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
    .stdout as string;
  if (clean)
    throw new RepositoryError(
      "Commit or remove every tracked and untracked change before preparing a release.",
      409,
    );
  const unmerged = (await git(worktree, ["ls-files", "-u", "-z"])).stdout as string;
  if (unmerged)
    throw new RepositoryError("Resolve every unmerged path before preparing a release.", 409);
  const head = ((await git(worktree, ["rev-parse", "HEAD"])).stdout as string).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
    throw new RepositoryError(
      "The committed revision uses an unsupported Git object identity.",
      409,
    );
  }
  await git(worktree, ["merge-base", "--is-ancestor", head, "HEAD"]);
  const relativeManifest = safeRelativePath(manifestPath, "The Tenkai manifest path");
  const canonicalWorktree = await realpath(worktree);
  const selectedManifest = resolve(canonicalWorktree, relativeManifest);
  const manifestMetadata = await lstat(selectedManifest).catch(() => {
    throw new RepositoryError("The selected Tenkai manifest is unavailable.", 404);
  });
  const manifestAbsolute = await realpath(selectedManifest).catch(() => {
    throw new RepositoryError("The selected Tenkai manifest is unavailable.", 404);
  });
  if (!within(canonicalWorktree, manifestAbsolute) || !manifestMetadata.isFile()) {
    throw new RepositoryError(
      "The Tenkai manifest must be a regular file inside the selected worktree.",
      403,
    );
  }
  await assertCommittedPath(worktree, relativeManifest, "The Tenkai manifest");
  const manifestBytes = await readCommittedReleaseManifest(worktree, relativeManifest);
  let manifest: TOML.JsonMap;
  try {
    manifest = TOML.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new RepositoryError("The selected Tenkai manifest is invalid.", 409);
  }
  const product = (manifest.product ?? {}) as TOML.JsonMap;
  const kind = product.kind ?? "software";
  if (kind !== "software") {
    throw new RepositoryError(
      "Version 1 delivery currently admits Tenkai software manifests only.",
      409,
    );
  }
  const productName = normalizedText(product.name, "The Tenkai product name", 128);
  const version = normalizedText(product.version, "The Tenkai product version", 128);
  if (!SAFE_ID.test(productName) || !SAFE_ID.test(version)) {
    throw new RepositoryError(
      "The Tenkai product and version are incompatible with local delivery.",
      409,
    );
  }
  const remote = ((await git(worktree, ["remote", "get-url", "origin"])).stdout as string).trim();
  const repositoryId = canonicalRepositoryIdentity(remote);
  const sourceDigest = await sourceTreeDigest(worktree);
  const manifestDigest = sha256(manifestBytes);
  const artifact = await artifactDigest(canonicalWorktree, manifestAbsolute, manifest);
  const build = await buildDefinition(canonicalWorktree);
  const artifactDescriptor: ReleaseArtifactDescriptor = {
    media_type: "application/vnd.tenkai.artifact-tree.v1+sha256",
    size: artifact.size,
    digest: artifact.digest,
    location_class: "local",
  };
  const document: AldunisDeliveryCandidate = {
    schema: "aldunis.delivery-candidate/v1",
    repository: { authority: "git", id: repositoryId },
    commit: { algorithm: head.length === 40 ? "sha1" : "sha256", oid: head },
    source_tree_digest: sourceDigest,
    manifest: { path: relativeManifest, digest: manifestDigest },
    artifacts: [artifactDescriptor],
    build_definition_digest: build.definitionDigest,
  };
  for (const digest of [sourceDigest, manifestDigest, artifact.digest, build.definitionDigest]) {
    if (!SHA256.test(digest)) throw new RepositoryError("A candidate digest is invalid.", 409);
  }
  const identity = sha256(Buffer.concat([CANDIDATE_DOMAIN, Buffer.from(canonicalJson(document))]));
  return {
    identity,
    document,
    chisei: {
      revision: head,
      source_tree_digest: sourceDigest,
      manifest_digest: manifestDigest,
      artifact_reference: `tenkai:artifact-tree:${artifact.digest}`,
      artifact_digest: artifact.digest,
      build_definition_digest: build.definitionDigest,
    },
    product: productName,
    version,
    release: `${productName}@${version}`,
    manifestPath: relativeManifest,
    build,
  };
}

export function deliveryCandidateIdentity(document: AldunisDeliveryCandidate): string {
  return sha256(Buffer.concat([CANDIDATE_DOMAIN, Buffer.from(canonicalJson(document))]));
}
