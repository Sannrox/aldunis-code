import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";
import { RepositoryError, constrainPath } from "./repository.ts";
import { isComposerAttachmentPath, isLocalRuntimePath } from "./local-runtime.ts";

const execFileAsync = promisify(execFile);
export const MAX_CONTEXT_FILES = 8;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_TEXT_BYTES = 256 * 1024;
export const MAX_CONTEXT_PACKAGE_FILES = 100;
export const MAX_CONTEXT_PACKAGE_BYTES = 2 * 1024 * 1024;
const CONTEXT_PACKAGE_READ_BUFFER_BYTES = 64 * 1024;
const MAX_CONTEXT_PACKAGE_INSPECTED_FILES = MAX_CONTEXT_PACKAGE_FILES * 2;
export const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVE_BROWSE_INSPECTIONS = 8;
const IMAGE_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
/** Unlikely to collide with user project trees; reserved for host-staged composer images. */
export const COMPOSER_ATTACHMENT_DIR = "aldunis-code-composer-images";
const MANAGED_STAGED_IMAGE_NAME = /^.+-[0-9a-f]{8}\.(gif|jpe?g|png|webp)$/i;
const MAX_STAGED_IMAGES_PER_WORKTREE = 32;
const MAX_STAGED_BYTES_PER_WORKTREE = 32 * 1024 * 1024;
export const MAX_INSPECTED_COMPOSER_ATTACHMENT_ENTRIES = 256;
/** Managed ignore file is exactly `*\n`; reject anything larger before reading it. */
export const MAX_COMPOSER_ATTACHMENT_IGNORE_BYTES = 16;

interface PreviewFileOperations {
  readFile(path: string, options: { signal?: AbortSignal }): Promise<Buffer>;
  open(path: string, flags: string): Promise<Pick<FileHandle, "read" | "close">>;
}

interface WorktreeImageFileOperations {
  open(path: string, flags: number): Promise<Pick<FileHandle, "stat" | "read" | "close">>;
  lstat(path: string): Promise<Stats>;
}

interface ContextPackageFileOperations {
  open(path: string, flags: string): Promise<Pick<FileHandle, "stat" | "read" | "close">>;
  lstat(path: string): Promise<Stats>;
}

export interface RepositoryBrowseOperations {
  readFile(path: string, options: { signal?: AbortSignal }): Promise<Buffer>;
  inspectRepositoryFile(
    worktree: string,
    path: string,
    match: RepositoryFileResult["match"],
    signal?: AbortSignal,
  ): Promise<RepositoryFileResult>;
}

const previewFileOperations: PreviewFileOperations = { readFile, open };
const worktreeImageFileOperations: WorktreeImageFileOperations = { open, lstat };
const contextPackageFileOperations: ContextPackageFileOperations = { open, lstat };

function matchesImageSignature(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mediaType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === "image/gif") {
    return (
      bytes.length >= 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61
    );
  }
  if (mediaType === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return false;
}

function sameContextFile(left: Stats, right: Stats): boolean {
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

function sameWorktreeImageFile(left: Stats, right: Stats): boolean {
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

export async function readStableWorktreeImage(
  path: string,
  displayPath: string,
  fileOperations: WorktreeImageFileOperations = worktreeImageFileOperations,
): Promise<Buffer | null> {
  const handle = await fileOperations.open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const details = await handle.stat();
    if (!details.isFile()) return null;
    if (!Number.isSafeInteger(details.size) || details.size < 0) {
      throw new RepositoryError(`${displayPath} has an unsupported image size.`, 413);
    }
    if (details.size > MAX_IMAGE_BYTES) {
      throw new RepositoryError(
        `${displayPath} exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB image limit.`,
        413,
      );
    }
    const [openedPath, openedCanonical] = await Promise.all([
      fileOperations.lstat(path).catch(() => null),
      realpath(path).catch(() => null),
    ]);
    if (
      !openedPath ||
      !openedCanonical ||
      resolve(openedCanonical) !== resolve(path) ||
      !sameWorktreeImageFile(details, openedPath)
    ) {
      throw new RepositoryError(`${displayPath} changed while it was opened.`, 409);
    }
    const bytes = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const [extraRead, after, pathname] = await Promise.all([
      handle.read(extra, 0, 1, offset),
      handle.stat(),
      fileOperations.lstat(path).catch(() => null),
    ]);
    if (
      offset !== details.size ||
      extraRead.bytesRead !== 0 ||
      !pathname ||
      !sameWorktreeImageFile(details, after) ||
      !sameWorktreeImageFile(after, pathname)
    ) {
      throw new RepositoryError(`${displayPath} changed while it was read.`, 409);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Read one admitted package file without retaining beyond the remaining package budget. */
export async function readBoundedContextPackageFile(
  path: string,
  admitted: Stats,
  maximum: number,
  signal?: AbortSignal,
  operations: ContextPackageFileOperations = contextPackageFileOperations,
): Promise<Buffer | null> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maximum) || maximum < 0 || admitted.size > maximum) return null;
  const handle = await operations.open(path, "r");
  try {
    const opened = await handle.stat();
    if (!sameContextFile(admitted, opened)) return null;
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(CONTEXT_PACKAGE_READ_BUFFER_BYTES, maximum + 1));
    let position = 0;
    while (position <= maximum) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, maximum + 1 - position),
        position,
      );
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    if (position > maximum) return null;
    const [after, pathname] = await Promise.all([
      handle.stat(),
      operations.lstat(path).catch(() => null),
    ]);
    if (
      !pathname ||
      position !== admitted.size ||
      !sameContextFile(admitted, after) ||
      !sameContextFile(after, pathname)
    ) {
      return null;
    }
    return Buffer.concat(chunks, position);
  } finally {
    await handle.close();
  }
}
const SECRET_NAMES =
  /(^|\/)(\.env(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.(?:bak|backup|old|orig|copy|tmp|save|swp))?|credentials(?:\.json)?(?:\.(?:bak|backup|old|orig|copy|tmp|save|swp))?|[^/]+\.(?:key|pem|p12|pfx)(?:\.(?:bak|backup|old|orig|copy|tmp|save|swp))?)$/i;
const SECRET_CONFIG_NAME_PART =
  /(?:^|[-_.])(?:api[-_.]?key|token|secret|credential|credentials|password|passwd|auth)\.(?:json|txt|data|db|env|sock|yaml|yml|conf|config|toml|ini|cfg|properties)(?:$|[-_.](?:bak|backup|old|orig|copy|tmp|save|swp|local|production|prod|staging|stage|development|dev|private|secret|secrets|credential|credentials|auth|token|tokens|key|keys|env|environment))$/i;
const SECRET_NAME_PART =
  /(?:^|[-_.])(?:api[-_.]?key|token|secret|credential|credentials|password|passwd|auth)(?:$|[-_.](?:token|secret|key|pem|p12|pfx))$/i;
const SECRET_COMPONENT_MARKER = /^(?:secret|secrets|token|tokens)$/i;
const SENSITIVE_FILENAME_MARKER =
  /^(?:secret|secrets|token|tokens)\.(?:json|yaml|yml|toml|ini|conf|config|env|txt|key|pem|p12|pfx)$/i;
const CREDENTIAL_BASENAME_MARKER =
  /(?:^|[-_.])(?:api|access|auth|bearer|client|credential|database|db|deploy|gateway|oauth|private|refresh|service|session|ssh|user)(?:[-_.]?(?:secret|secrets|token|tokens))(?:$|\.(?:json|yaml|yml|toml|ini|conf|config|env|txt|key|pem|p12|pfx)$)/i;
const DOCUMENTED_SECRET_BASENAME =
  /(?:\.env|\.(?:json|txt|data|db|env|sock|yaml|yml|conf|config|toml|ini|cfg|properties))\.(?:example|template|md)$/i;
function isSecretLikePath(path: string): boolean {
  const components = path.split("/");
  const basename = components.at(-1) ?? "";
  if (components.some((component) => SECRET_COMPONENT_MARKER.test(component))) return true;
  if (DOCUMENTED_SECRET_BASENAME.test(basename)) return false;
  return (
    SECRET_NAMES.test(path) ||
    SENSITIVE_FILENAME_MARKER.test(basename) ||
    SECRET_CONFIG_NAME_PART.test(basename) ||
    SECRET_NAME_PART.test(basename) ||
    CREDENTIAL_BASENAME_MARKER.test(basename)
  );
}

async function isTrackedRepositoryPath(worktree: string, path: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["--literal-pathspecs", "-C", worktree, "ls-files", "--error-unmatch", "--", path],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      },
    );
    return true;
  } catch {
    return false;
  }
}

export interface ContextAttachment {
  path: string;
  kind: "text" | "image";
  mediaType: string;
  size: number;
  content?: string;
}

export interface ContextPin {
  path: string;
  kind: "file" | "folder";
}

export type ContextReceiptSource =
  "aldunis_attachment" | "aldunis_folder" | "provider_managed_instruction";

export interface ContextReceiptEntry {
  path: string;
  type: "text" | "image" | "folder" | "instruction" | "unsupported";
  source: ContextReceiptSource;
  bytes: number | null;
  truncated: boolean;
  digest: string | null;
  omissionReason: string | null;
}

export interface AssembledContextPackage {
  pins: ContextPin[];
  entries: ContextReceiptEntry[];
  attachments: ContextAttachment[];
  totalBytes: number;
  estimatedTokens: number;
  digest: string;
}

export interface ContextElementReference {
  selector: string;
  tag: string;
  role?: string | null;
  name?: string | null;
  text?: string | null;
}

export interface RepositoryFileResult {
  path: string;
  kind: "text" | "image" | "binary" | "oversized" | "inaccessible";
  size: number | null;
  match: "name" | "content" | null;
}

export interface RepositoryFilePreview extends RepositoryFileResult {
  mediaType: string | null;
  content: string | null;
  imageData: string | null;
  truncated: boolean;
  encoding: "utf-8" | "binary" | "image" | "unavailable";
  message: string | null;
  attachable: boolean;
}

function relativeFilePath(worktree: string, input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (!normalized || normalized.includes("\0") || isAbsolute(input)) {
    throw new RepositoryError("Context paths must be repository-relative.");
  }
  const candidate = relative(worktree, join(worktree, normalized));
  if (candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    throw new RepositoryError("The requested context path escapes the selected worktree.", 403);
  }
  return normalized;
}

function assertNotSecretLike(path: string): void {
  if (isSecretLikePath(path)) {
    throw new RepositoryError(`${path} looks secret-like and cannot be attached.`, 403);
  }
}

function isHidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function isProviderInstruction(path: string): boolean {
  return /(^|\/)(AGENTS|CLAUDE)\.md$/i.test(path);
}

async function repositoryPaths(worktree: string, signal?: AbortSignal): Promise<string[]> {
  const gitOptions = {
    encoding: "utf8" as const,
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
    signal,
  };
  const [{ stdout: trackedStdout }, { stdout: untrackedStdout }] = await Promise.all([
    execFileAsync("git", ["-C", worktree, "ls-files", "--cached", "-z"], gitOptions),
    execFileAsync(
      "git",
      ["-C", worktree, "ls-files", "--others", "--exclude-standard", "-z"],
      gitOptions,
    ),
  ]);
  const tracked = trackedStdout.split("\0").filter(Boolean);
  const untracked = untrackedStdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => !isLocalRuntimePath(path));
  return [...tracked, ...untracked]
    .filter((path) => !isHidden(path) && !isSecretLikePath(path))
    .sort((left, right) => left.localeCompare(right));
}

function packageDigest(entries: ContextReceiptEntry[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((entry) => ({
          path: entry.path,
          type: entry.type,
          source: entry.source,
          bytes: entry.bytes,
          truncated: entry.truncated,
          digest: entry.digest,
          omissionReason: entry.omissionReason,
        })),
      ),
      "utf8",
    )
    .digest("hex");
}

function omittedEntry(
  path: string,
  source: ContextReceiptSource,
  reason: string,
  type: ContextReceiptEntry["type"] = "unsupported",
): ContextReceiptEntry {
  return {
    path,
    type,
    source,
    bytes: null,
    truncated: false,
    digest: null,
    omissionReason: reason,
  };
}

/**
 * Resolve explicit file/folder pins through Git's tracked + non-ignored view.
 * Content is returned only for immediate prompt assembly; receipts retain
 * metadata and digests, never a second copy of repository source.
 */
export async function assembleContextPackage(
  worktree: string,
  requestedPins: ContextPin[],
  options: { includeProviderInstructions?: boolean; signal?: AbortSignal } = {},
): Promise<AssembledContextPackage> {
  options.signal?.throwIfAborted();
  const pins = requestedPins.map((pin) => ({
    path: relativeFilePath(worktree, pin.path).replace(/\/+$/, ""),
    kind: pin.kind,
  }));
  const uniquePins = [...new Map(pins.map((pin) => [`${pin.kind}:${pin.path}`, pin])).values()];
  const available = await repositoryPaths(worktree, options.signal);
  const availableSet = new Set(available);
  const selected = new Map<string, ContextReceiptSource>();
  const entries: ContextReceiptEntry[] = [];

  for (const pin of uniquePins) {
    const isUntrackedRuntimeFile =
      pin.kind === "file" && isLocalRuntimePath(pin.path) && !availableSet.has(pin.path);
    if (
      pin.path !== "." &&
      (isSecretLikePath(pin.path) || isUntrackedRuntimeFile || isHidden(pin.path))
    ) {
      entries.push(
        omittedEntry(
          pin.path,
          pin.kind === "folder" ? "aldunis_folder" : "aldunis_attachment",
          "ignored, secret-like, or local runtime path",
        ),
      );
      continue;
    }
    if (pin.kind === "file" && isProviderInstruction(pin.path)) {
      if (options.includeProviderInstructions === false) {
        entries.push(
          omittedEntry(
            pin.path,
            "provider_managed_instruction",
            "provider-managed instruction is not attached",
            "instruction",
          ),
        );
      }
      continue;
    }
    if (pin.kind === "folder") {
      const prefix = `${pin.path}/`;
      const matches =
        pin.path === "." ? available : available.filter((path) => path.startsWith(prefix));
      const attachableMatches = matches.filter((path) => !isProviderInstruction(path));
      if (matches.length === 0) {
        entries.push(
          omittedEntry(
            pin.path,
            "aldunis_folder",
            "folder is empty, ignored, missing, or outside the repository",
            "folder",
          ),
        );
        continue;
      }
      for (const path of attachableMatches) selected.set(path, "aldunis_folder");
      continue;
    }
    if (!availableSet.has(pin.path)) {
      // Host-staged composer images are intentionally gitignored so screenshots
      // cannot be `git add -A`'d by accident, but remain explicit attach targets.
      if (pin.kind === "file" && isComposerAttachmentPath(pin.path)) {
        selected.set(pin.path, "aldunis_attachment");
        continue;
      }
      entries.push(
        omittedEntry(
          pin.path,
          "aldunis_attachment",
          "file is ignored, missing, or outside the repository",
        ),
      );
      continue;
    }
    selected.set(pin.path, "aldunis_attachment");
  }

  const attachments: ContextAttachment[] = [];
  let totalBytes = 0;
  let inspectedBytes = 0;
  const paths = [...selected].sort(([left], [right]) => left.localeCompare(right));
  let pathIndex = 0;
  for (
    ;
    pathIndex < paths.length && pathIndex < MAX_CONTEXT_PACKAGE_INSPECTED_FILES;
    pathIndex += 1
  ) {
    options.signal?.throwIfAborted();
    if (attachments.length >= MAX_CONTEXT_PACKAGE_FILES) break;
    const [path, source] = paths[pathIndex];
    const direct = await lstat(join(worktree, path)).catch(() => null);
    if (!direct) {
      entries.push(omittedEntry(path, source, "file changed or disappeared during resolution"));
      continue;
    }
    if (direct.isSymbolicLink()) {
      entries.push(omittedEntry(path, source, "symlink"));
      continue;
    }
    if (!direct.isFile()) {
      entries.push(
        omittedEntry(path, source, "submodule, nested repository, or unsupported entry"),
      );
      continue;
    }
    const remainingBytes = MAX_CONTEXT_PACKAGE_BYTES - inspectedBytes;
    if (direct.size > remainingBytes) {
      entries.push(omittedEntry(path, source, "package byte limit"));
      continue;
    }
    inspectedBytes += direct.size;
    const canonical = await constrainPath(worktree, join(worktree, path));
    const bytes = await readBoundedContextPackageFile(
      canonical,
      direct,
      remainingBytes,
      options.signal,
    );
    if (!bytes) {
      entries.push(omittedEntry(path, source, "file changed during resolution"));
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const mediaType = IMAGE_TYPES[extname(path).toLocaleLowerCase()];
    if (mediaType) {
      attachments.push({ path, kind: "image", mediaType, size: bytes.length });
      entries.push({
        path,
        type: "image",
        source,
        bytes: bytes.length,
        truncated: false,
        digest,
        omissionReason: null,
      });
      totalBytes += bytes.length;
      continue;
    }
    if (bytes.includes(0)) {
      entries.push(omittedEntry(path, source, "unsupported binary file"));
      continue;
    }
    attachments.push({
      path,
      kind: "text",
      mediaType: "text/plain",
      size: bytes.length,
      content: bytes.toString("utf8"),
    });
    entries.push({
      path,
      type: "text",
      source,
      bytes: bytes.length,
      truncated: false,
      digest,
      omissionReason: null,
    });
    totalBytes += bytes.length;
  }
  if (pathIndex < paths.length) {
    const limit =
      attachments.length >= MAX_CONTEXT_PACKAGE_FILES
        ? "package file limit"
        : "package inspection limit";
    entries.push(
      omittedEntry(
        `${paths.length - pathIndex} additional files`,
        "aldunis_folder",
        limit,
        "folder",
      ),
    );
  }

  if (options.includeProviderInstructions !== false) {
    options.signal?.throwIfAborted();
    for (const path of available.filter(isProviderInstruction)) {
      if (selected.has(path)) continue;
      entries.push({
        path,
        type: "instruction",
        source: "provider_managed_instruction",
        bytes: null,
        truncated: false,
        digest: null,
        omissionReason: "provider-managed effectiveness was not reported",
      });
    }
  }
  const orderedEntries = entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    pins: uniquePins,
    entries: orderedEntries,
    attachments,
    totalBytes,
    estimatedTokens: Math.ceil(totalBytes / 4),
    digest: packageDigest(orderedEntries),
  };
}

async function inspectRepositoryFile(
  worktree: string,
  path: string,
  match: RepositoryFileResult["match"],
  signal?: AbortSignal,
): Promise<RepositoryFileResult> {
  try {
    signal?.throwIfAborted();
    const direct = await lstat(join(worktree, path));
    signal?.throwIfAborted();
    if (direct.isSymbolicLink()) {
      return { path, kind: "inaccessible", size: null, match };
    }
    const canonical = await constrainPath(worktree, join(worktree, path));
    signal?.throwIfAborted();
    const details = await stat(canonical);
    signal?.throwIfAborted();
    if (!details.isFile()) return { path, kind: "inaccessible", size: null, match };
    if (IMAGE_TYPES[extname(path).toLocaleLowerCase()]) {
      return {
        path,
        kind: details.size > MAX_IMAGE_BYTES ? "oversized" : "image",
        size: details.size,
        match,
      };
    }
    if (details.size > MAX_PREVIEW_BYTES) {
      return { path, kind: "oversized", size: details.size, match };
    }
    const bytes = await readFile(canonical, { signal });
    signal?.throwIfAborted();
    return {
      path,
      kind: bytes.includes(0) ? "binary" : "text",
      size: details.size,
      match,
    };
  } catch {
    signal?.throwIfAborted();
    return { path, kind: "inaccessible", size: null, match };
  }
}

const repositoryBrowseOperations: RepositoryBrowseOperations = { readFile, inspectRepositoryFile };

async function inspectRepositoryFiles(
  worktree: string,
  selected: Array<{ path: string; match: RepositoryFileResult["match"] }>,
  signal: AbortSignal | undefined,
  operations: RepositoryBrowseOperations,
): Promise<RepositoryFileResult[]> {
  const files = new Array<RepositoryFileResult>(selected.length);
  let nextIndex = 0;
  const inspectNext = async (): Promise<void> => {
    while (nextIndex < selected.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      const { path, match } = selected[index];
      files[index] = await operations.inspectRepositoryFile(worktree, path, match, signal);
      signal?.throwIfAborted();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_ACTIVE_BROWSE_INSPECTIONS, selected.length) }, inspectNext),
  );
  return files;
}

export async function searchRepositoryFiles(
  worktree: string,
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const needle = query.trim().toLocaleLowerCase();
  return (await repositoryPaths(worktree, signal))
    .filter((path) => !needle || path.toLocaleLowerCase().includes(needle))
    .sort((left, right) => {
      const leftName = left.split("/").at(-1)?.toLocaleLowerCase() ?? left;
      const rightName = right.split("/").at(-1)?.toLocaleLowerCase() ?? right;
      const leftStarts = leftName.startsWith(needle) ? 0 : 1;
      const rightStarts = rightName.startsWith(needle) ? 0 : 1;
      return leftStarts - rightStarts || left.localeCompare(right);
    })
    .slice(0, boundedLimit);
}

export async function browseRepositoryFiles(
  worktree: string,
  query: string,
  signal?: AbortSignal,
  limit = 100,
  operations: RepositoryBrowseOperations = repositoryBrowseOperations,
): Promise<{ files: RepositoryFileResult[]; truncated: boolean }> {
  const needle = query.trim().toLocaleLowerCase();
  const paths = await repositoryPaths(worktree, signal);
  const matches: Array<{ path: string; match: RepositoryFileResult["match"] }> = [];
  let searchedBytes = 0;
  let searchBudgetExhausted = false;
  for (const path of paths) {
    if (signal?.aborted) throw signal.reason;
    // Staged composer images are attachable context, not a browse surface.
    if (isComposerAttachmentPath(path)) continue;
    if (!needle || path.toLocaleLowerCase().includes(needle)) {
      matches.push({ path, match: needle ? "name" : null });
      continue;
    }
    if (searchedBytes >= MAX_SEARCH_BYTES) {
      searchBudgetExhausted = true;
      continue;
    }
    try {
      const direct = await lstat(join(worktree, path));
      if (direct.isSymbolicLink() || !direct.isFile() || direct.size > MAX_PREVIEW_BYTES) continue;
      const canonical = await constrainPath(worktree, join(worktree, path));
      const bytes = await operations.readFile(canonical, { signal });
      signal?.throwIfAborted();
      searchedBytes += bytes.length;
      if (!bytes.includes(0) && bytes.toString("utf8").toLocaleLowerCase().includes(needle)) {
        matches.push({ path, match: "content" });
      }
    } catch {
      signal?.throwIfAborted();
      // Inaccessible and racing files remain discoverable only through a name match.
    }
  }
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const selected = matches.slice(0, boundedLimit);
  return {
    files: await inspectRepositoryFiles(worktree, selected, signal, operations),
    truncated: matches.length > selected.length || searchBudgetExhausted,
  };
}

export async function previewRepositoryFile(
  worktree: string,
  input: string,
  signal?: AbortSignal,
  fileOperations: PreviewFileOperations = previewFileOperations,
): Promise<RepositoryFilePreview> {
  signal?.throwIfAborted();
  const path = relativeFilePath(worktree, input);
  assertNotSecretLike(path);
  if (isLocalRuntimePath(path)) {
    const tracked = await isTrackedRepositoryPath(worktree, path);
    signal?.throwIfAborted();
    if (!tracked)
      throw new RepositoryError(`${path} is local runtime state and cannot be previewed.`, 403);
  }
  if (isHidden(path)) throw new RepositoryError("Hidden files are not available for preview.", 403);
  const direct = await lstat(join(worktree, path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new RepositoryError(`${path} is missing or was deleted.`, 404);
    throw new RepositoryError(`${path} is inaccessible.`, 403);
  });
  signal?.throwIfAborted();
  if (direct.isSymbolicLink()) {
    throw new RepositoryError("Symlinks are not available for preview.", 403);
  }
  const canonical = await constrainPath(worktree, join(worktree, path));
  signal?.throwIfAborted();
  const details = await stat(canonical);
  signal?.throwIfAborted();
  if (!details.isFile()) throw new RepositoryError(`${path} is not a file.`);
  const mediaType = IMAGE_TYPES[extname(path).toLocaleLowerCase()] ?? null;
  if (mediaType) {
    if (details.size > MAX_IMAGE_BYTES) {
      return {
        path,
        kind: "oversized",
        size: details.size,
        match: null,
        mediaType,
        content: null,
        imageData: null,
        truncated: false,
        encoding: "unavailable",
        message: `Image preview exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`,
        attachable: false,
      };
    }
    const bytes = await fileOperations.readFile(canonical, { signal });
    signal?.throwIfAborted();
    return {
      path,
      kind: "image",
      size: details.size,
      match: null,
      mediaType,
      content: null,
      imageData: `data:${mediaType};base64,${bytes.toString("base64")}`,
      truncated: false,
      encoding: "image",
      message: null,
      attachable: true,
    };
  }
  signal?.throwIfAborted();
  const handle = await fileOperations.open(canonical, "r");
  try {
    signal?.throwIfAborted();
    const length = Math.min(details.size, MAX_PREVIEW_BYTES);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, 0);
    signal?.throwIfAborted();
    if (bytes.includes(0)) {
      return {
        path,
        kind: "binary",
        size: details.size,
        match: null,
        mediaType: null,
        content: null,
        imageData: null,
        truncated: false,
        encoding: "binary",
        message: "Binary files are not rendered as text.",
        attachable: false,
      };
    }
    const truncated = details.size > MAX_PREVIEW_BYTES;
    return {
      path,
      kind: truncated ? "oversized" : "text",
      size: details.size,
      match: null,
      mediaType: "text/plain",
      content: bytes.toString("utf8"),
      imageData: null,
      truncated,
      encoding: "utf-8",
      message: truncated ? `Preview is truncated at ${MAX_PREVIEW_BYTES / 1024} KB.` : null,
      attachable: details.size <= MAX_TEXT_BYTES,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Stage a bounded image into the worktree so it can be pinned as ordinary
 * local context. Files land under `aldunis-code-composer-images/` (non-hidden)
 * and stay out of the Changes review surface via `isComposerAttachmentPath`.
 */
export async function stageComposerImage(
  worktree: string,
  input: {
    mediaType: string;
    data: string;
    name?: string;
    conversationId?: string;
  },
): Promise<{ path: string; mediaType: string; size: number }> {
  return withComposerAttachmentLock(worktree, async () => {
    const mediaType = input.mediaType.trim().toLocaleLowerCase();
    const extension = IMAGE_EXTENSIONS[mediaType];
    if (!extension) {
      throw new RepositoryError(
        "Only GIF, JPEG, PNG, and WebP images can be staged into the composer.",
        415,
      );
    }
    const base64 = input.data.replace(/\s+/g, "");
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new RepositoryError("Image data must be valid base64.", 400);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      throw new RepositoryError("Image data must be valid base64.", 400);
    }
    // Reject empty and padded-garbage payloads that decode to nothing useful.
    if (bytes.length === 0) throw new RepositoryError("Image data is empty.", 400);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new RepositoryError(`Images must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`, 413);
    }
    if (!matchesImageSignature(bytes, mediaType)) {
      throw new RepositoryError("Image data does not match the declared image type.", 415);
    }
    const scope =
      typeof input.conversationId === "string" && /^[0-9a-f-]{8,36}$/i.test(input.conversationId)
        ? input.conversationId.toLocaleLowerCase()
        : "shared";
    const originalName =
      (input.name ?? `image${extension}`).replaceAll("\\", "/").split("/").pop() ?? "image";
    const safeStem = originalName
      .replace(extname(originalName), "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const fileName = `${safeStem || "image"}-${randomUUID().slice(0, 8)}${extension}`;
    const relativePath = `${COMPOSER_ATTACHMENT_DIR}/${scope}/${fileName}`;
    const rootAttachmentDir = join(worktree, COMPOSER_ATTACHMENT_DIR);
    await ensureComposerAttachmentDirectory(worktree, rootAttachmentDir);
    const canonicalRoot = await constrainPath(worktree, rootAttachmentDir);
    await ensureComposerAttachmentIgnore(canonicalRoot);
    const release = await lock(join(canonicalRoot, ".quota"), {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 1_200, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      const directory = join(canonicalRoot, scope);
      const existingDirectory = await lstat(directory).catch(() => null);
      if (existingDirectory?.isSymbolicLink()) {
        throw new RepositoryError("Composer attachment path cannot be a symlink.", 403);
      }
      if (existingDirectory && !existingDirectory.isDirectory()) {
        throw new RepositoryError("Composer attachment path is not a directory.", 409);
      }
      await enforceComposerAttachmentQuota(canonicalRoot, bytes.length, existingDirectory ? 0 : 1);
      await ensureDirectory(directory);
      const canonicalDirectory = await constrainPath(worktree, directory);
      const canonical = join(canonicalDirectory, fileName);
      await writeFile(canonical, bytes, { flag: "wx" });
      return { path: relativePath, mediaType, size: bytes.length };
    } finally {
      await release();
    }
  });
}

async function listManagedStagedImages(
  rootAttachmentDir: string,
  maxInspectedEntries: number,
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  let inspected = 0;
  const inspect = () => {
    inspected += 1;
    if (inspected > maxInspectedEntries) {
      throw new RepositoryError(
        `Composer image staging contains too many entries to inspect (max ${MAX_INSPECTED_COMPOSER_ATTACHMENT_ENTRIES}). Remove older staged images and try again.`,
        413,
      );
    }
  };
  const scopes = await opendir(rootAttachmentDir);
  for await (const scope of scopes) {
    inspect();
    if (!scope.isDirectory()) continue;
    const scopeDir = join(rootAttachmentDir, scope.name);
    const entries = await opendir(scopeDir).catch(() => null);
    if (!entries) continue;
    for await (const entry of entries) {
      inspect();
      if (!entry.isFile() || !MANAGED_STAGED_IMAGE_NAME.test(entry.name)) continue;
      const path = join(scopeDir, entry.name);
      const details = await stat(path).catch(() => null);
      if (!details) continue;
      files.push({ path, size: details.size, mtimeMs: details.mtimeMs });
    }
  }
  return files;
}

/** Bound disk use without deleting files still referenced by conversation pins. */
async function enforceComposerAttachmentQuota(
  rootAttachmentDir: string,
  incomingBytes: number,
  incomingEntries: number,
): Promise<void> {
  const files = await listManagedStagedImages(
    rootAttachmentDir,
    MAX_INSPECTED_COMPOSER_ATTACHMENT_ENTRIES - incomingEntries,
  );
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0) + incomingBytes;
  if (
    files.length >= MAX_STAGED_IMAGES_PER_WORKTREE ||
    totalBytes > MAX_STAGED_BYTES_PER_WORKTREE
  ) {
    throw new RepositoryError(
      `Composer image staging is full (at most ${MAX_STAGED_IMAGES_PER_WORKTREE} images or ${MAX_STAGED_BYTES_PER_WORKTREE / 1024 / 1024} MB under ${COMPOSER_ATTACHMENT_DIR}/). Remove older staged images and try again.`,
      413,
    );
  }
}

const composerAttachmentLocks = new Map<string, Promise<void>>();

async function withComposerAttachmentLock<T>(
  worktree: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = resolve(worktree);
  const previous = composerAttachmentLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const chain = previous.then(() => gate);
  composerAttachmentLocks.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (composerAttachmentLocks.get(key) === chain) composerAttachmentLocks.delete(key);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new RepositoryError("Composer attachment path cannot be a symlink.", 403);
  }
  if (existing && !existing.isDirectory()) {
    throw new RepositoryError("Composer attachment path is not a directory.", 409);
  }
  if (existing) return;
  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    // Concurrent staging can win the create race; revalidate the winner.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await lstat(path).catch(() => null);
    if (!raced || raced.isSymbolicLink() || !raced.isDirectory()) {
      throw new RepositoryError("Composer attachment path is not a directory.", 409);
    }
  }
}

async function ensureComposerAttachmentDirectory(
  worktree: string,
  rootAttachmentDir: string,
): Promise<void> {
  await ensureDirectory(rootAttachmentDir);
  // Confirm the created/existing directory still lives inside the worktree.
  await constrainPath(worktree, rootAttachmentDir);
}

async function readComposerAttachmentIgnore(ignoreFile: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(ignoreFile, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!Number.isSafeInteger(details.size) || details.size < 0) {
      throw new RepositoryError(
        "aldunis-code-composer-images/.gitignore must use the Aldunis-managed ignore rule (* only).",
        409,
      );
    }
    if (details.size > MAX_COMPOSER_ATTACHMENT_IGNORE_BYTES) {
      throw new RepositoryError(
        "aldunis-code-composer-images/.gitignore exceeds the supported size.",
        413,
      );
    }
    const bytes = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (offset !== details.size || (await handle.read(extra, 0, 1, offset)).bytesRead > 0) {
      throw new RepositoryError(
        "aldunis-code-composer-images/.gitignore changed while being read.",
        409,
      );
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function ensureComposerAttachmentIgnore(rootAttachmentDir: string): Promise<void> {
  const ignoreFile = join(rootAttachmentDir, ".gitignore");
  // Exact rule only: ignore everything in this directory, including this file.
  // No negation rules, so screenshots and the ignore file stay out of `git add -A`.
  const required = "*\n";
  const current = await readComposerAttachmentIgnore(ignoreFile);
  if (current === null) {
    try {
      await writeFile(ignoreFile, required, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another request created the ignore file; re-read and validate below.
    }
  } else if (current === required) {
    return;
  }
  let effective: string | null;
  try {
    effective = await readComposerAttachmentIgnore(ignoreFile);
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    effective = null;
  }
  if (effective === required) return;
  throw new RepositoryError(
    "aldunis-code-composer-images/.gitignore must use the Aldunis-managed ignore rule (* only).",
    409,
  );
}

/**
 * When the desktop shell exposes an absolute path for a dropped file, pin it
 * directly when it already lives inside the selected worktree and is visible
 * to Git-backed context assembly. Ignored in-tree images return null so the
 * host can stage a bounded copy under `aldunis-code-composer-images/` instead.
 */
export async function resolveWorktreeImagePath(
  worktree: string,
  absolutePath: string,
  fileOperations: WorktreeImageFileOperations = worktreeImageFileOperations,
): Promise<{ path: string; mediaType: string; size: number } | null> {
  if (!absolutePath || absolutePath.includes("\0") || !isAbsolute(absolutePath)) return null;
  const normalizedWorktree = resolve(worktree);
  const candidate = resolve(absolutePath);
  const relativePath = relative(normalizedWorktree, candidate).replaceAll("\\", "/");
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  if (isHidden(relativePath) || isSecretLikePath(relativePath)) return null;
  if (
    isLocalRuntimePath(relativePath) &&
    !(await isTrackedRepositoryPath(worktree, relativePath))
  ) {
    return null;
  }
  const direct = await lstat(candidate).catch(() => null);
  if (!direct || direct.isSymbolicLink() || !direct.isFile()) return null;
  const mediaType = IMAGE_TYPES[extname(relativePath).toLocaleLowerCase()];
  if (!mediaType) return null;
  if (direct.size > MAX_IMAGE_BYTES) {
    throw new RepositoryError(
      `${relativePath} exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB image limit.`,
      413,
    );
  }
  // Ensure the path still canonicalizes inside the worktree (symlink races).
  const canonical = await constrainPath(worktree, candidate);
  const bytes = await readStableWorktreeImage(canonical, relativePath, fileOperations);
  if (!bytes) return null;
  if (!matchesImageSignature(bytes, mediaType)) {
    throw new RepositoryError("Image data does not match the declared image type.", 415);
  }
  if (isComposerAttachmentPath(relativePath)) {
    return { path: relativePath, mediaType, size: bytes.length };
  }
  const available = await repositoryPaths(worktree);
  if (!available.includes(relativePath)) {
    // Ignored/unlisted — caller should stage a copy rather than pin a no-op path.
    return null;
  }
  return { path: relativePath, mediaType, size: bytes.length };
}

/** Read a worktree-local image and stage a gitignored attachable copy. */
export async function stageWorktreeImageCopy(
  worktree: string,
  absolutePath: string,
  options: { conversationId?: string } = {},
  fileOperations: WorktreeImageFileOperations = worktreeImageFileOperations,
): Promise<{ path: string; mediaType: string; size: number } | null> {
  if (!absolutePath || absolutePath.includes("\0") || !isAbsolute(absolutePath)) return null;
  const normalizedWorktree = resolve(worktree);
  const candidate = resolve(absolutePath);
  const relativePath = relative(normalizedWorktree, candidate).replaceAll("\\", "/");
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  if (isHidden(relativePath) || isSecretLikePath(relativePath)) return null;
  const direct = await lstat(candidate).catch(() => null);
  if (!direct || direct.isSymbolicLink() || !direct.isFile()) return null;
  const mediaType = IMAGE_TYPES[extname(relativePath).toLocaleLowerCase()];
  if (!mediaType) return null;
  const canonical = await constrainPath(worktree, candidate);
  const bytes = await readStableWorktreeImage(canonical, relativePath, fileOperations);
  if (!bytes) return null;
  if (!matchesImageSignature(bytes, mediaType)) {
    throw new RepositoryError("Image data does not match the declared image type.", 415);
  }
  return stageComposerImage(worktree, {
    mediaType,
    data: bytes.toString("base64"),
    name: relativePath.split("/").pop() ?? `image${IMAGE_EXTENSIONS[mediaType]}`,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
  });
}

export async function resolveContextAttachments(
  worktree: string,
  inputs: string[],
): Promise<ContextAttachment[]> {
  const paths = [...new Set(inputs)];
  if (paths.length > MAX_CONTEXT_FILES) {
    throw new RepositoryError(`Attach at most ${MAX_CONTEXT_FILES} files.`);
  }
  let totalTextBytes = 0;
  return Promise.all(
    paths.map(async (input) => {
      const path = relativeFilePath(worktree, input);
      assertNotSecretLike(path);
      if (isLocalRuntimePath(path) && !(await isTrackedRepositoryPath(worktree, path)))
        throw new RepositoryError(`${path} is local runtime state and cannot be attached.`, 403);
      if (isHidden(path))
        throw new RepositoryError(`${path} is hidden and cannot be attached.`, 403);
      const direct = await lstat(join(worktree, path)).catch(() => null);
      if (direct?.isSymbolicLink()) {
        throw new RepositoryError(`${path} is a symlink and cannot be attached.`, 403);
      }
      let canonical: string;
      try {
        canonical = await constrainPath(worktree, join(worktree, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new RepositoryError(`${path} is missing or was deleted.`, 404);
        }
        throw error;
      }
      const details = await stat(canonical);
      if (!details.isFile()) throw new RepositoryError(`${path} is not a file.`);
      const mediaType = IMAGE_TYPES[extname(path).toLocaleLowerCase()];
      if (mediaType) {
        if (details.size > MAX_IMAGE_BYTES) {
          throw new RepositoryError(
            `${path} exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB image limit.`,
            413,
          );
        }
        return { path, kind: "image", mediaType, size: details.size };
      }
      if (details.size > MAX_TEXT_BYTES) {
        throw new RepositoryError(
          `${path} exceeds the ${MAX_TEXT_BYTES / 1024} KB text limit.`,
          413,
        );
      }
      const bytes = await readFile(canonical);
      if (bytes.includes(0)) throw new RepositoryError(`${path} is binary and cannot be attached.`);
      totalTextBytes += bytes.length;
      if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
        throw new RepositoryError(
          `Text context exceeds the ${MAX_TOTAL_TEXT_BYTES / 1024} KB total limit.`,
          413,
        );
      }
      return {
        path,
        kind: "text",
        mediaType: "text/plain",
        size: bytes.length,
        content: bytes.toString("utf8"),
      };
    }),
  );
}

function escapeContext(value: string, limit: number): string {
  return value
    .slice(0, limit)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function composePrompt(
  prompt: string,
  attachments: ContextAttachment[],
  elementReferences: ContextElementReference[] = [],
): string {
  if (attachments.length === 0 && elementReferences.length === 0) return prompt;
  const context = attachments
    .map((attachment) =>
      attachment.kind === "text"
        ? `<file path="${attachment.path}">\n${attachment.content}\n</file>`
        : `<image path="${attachment.path}" media-type="${attachment.mediaType}" size="${attachment.size}" />`,
    )
    .concat(
      elementReferences
        .slice(0, 3)
        .map(
          (reference) =>
            `<visible-element selector="${escapeContext(reference.selector, 240)}" tag="${escapeContext(reference.tag, 32)}" role="${escapeContext(reference.role ?? "", 80)}" name="${escapeContext(reference.name ?? "", 240)}">${escapeContext(reference.text ?? "", 500)}</visible-element>`,
        ),
    )
    .join("\n\n");
  return `${prompt}\n\n<aldunis-local-context>\n${context}\n</aldunis-local-context>`;
}
