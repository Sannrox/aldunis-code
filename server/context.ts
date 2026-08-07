import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { RepositoryError, constrainPath } from "./repository.ts";

const execFileAsync = promisify(execFile);
export const MAX_CONTEXT_FILES = 8;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_TEXT_BYTES = 256 * 1024;
export const MAX_CONTEXT_PACKAGE_FILES = 100;
export const MAX_CONTEXT_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_PACKAGE_INSPECTED_FILES = MAX_CONTEXT_PACKAGE_FILES * 2;
export const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const SECRET_NAMES = /(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|credentials(?:\.json)?$|.*\.(?:key|pem|p12|pfx))$/i;
const SECRET_COMPONENT_MARKER = /^(?:secret|secrets|token|tokens)$/i;
const SENSITIVE_FILENAME_MARKER = /^(?:secret|secrets|token|tokens)\.(?:json|yaml|yml|toml|ini|conf|config|env|txt|key|pem|p12|pfx)$/i;
const CREDENTIAL_BASENAME_MARKER = /(?:^|[-_.])(?:api|access|auth|bearer|client|credential|database|db|deploy|gateway|oauth|private|refresh|service|session|ssh|user)(?:[-_.]?(?:secret|secrets|token|tokens))(?:$|\.(?:json|yaml|yml|toml|ini|conf|config|env|txt|key|pem|p12|pfx)$)/i;

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
  | "aldunis_attachment"
  | "aldunis_folder"
  | "provider_managed_instruction";

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

function isSecretLikePath(path: string): boolean {
  const components = path.split("/");
  const basename = components.at(-1) ?? "";
  return SECRET_NAMES.test(path)
    || components.some((component) => SECRET_COMPONENT_MARKER.test(component))
    || SENSITIVE_FILENAME_MARKER.test(basename)
    || CREDENTIAL_BASENAME_MARKER.test(basename);
}

function isHidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function isProviderInstruction(path: string): boolean {
  return /(^|\/)(AGENTS|CLAUDE)\.md$/i.test(path);
}

async function repositoryPaths(worktree: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    },
  );
  return stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => !isHidden(path) && !isSecretLikePath(path))
    .sort((left, right) => left.localeCompare(right));
}

function packageDigest(entries: ContextReceiptEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      source: entry.source,
      bytes: entry.bytes,
      truncated: entry.truncated,
      digest: entry.digest,
      omissionReason: entry.omissionReason,
    }))), "utf8")
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
  options: { includeProviderInstructions?: boolean } = {},
): Promise<AssembledContextPackage> {
  const pins = requestedPins.map((pin) => ({
    path: relativeFilePath(worktree, pin.path).replace(/\/+$/, ""),
    kind: pin.kind,
  }));
  const uniquePins = [...new Map(pins.map((pin) => [`${pin.kind}:${pin.path}`, pin])).values()];
  const available = await repositoryPaths(worktree);
  const availableSet = new Set(available);
  const selected = new Map<string, ContextReceiptSource>();
  const entries: ContextReceiptEntry[] = [];

  for (const pin of uniquePins) {
    if (pin.path !== "." && (isSecretLikePath(pin.path) || isHidden(pin.path))) {
      entries.push(omittedEntry(pin.path, pin.kind === "folder" ? "aldunis_folder" : "aldunis_attachment", "ignored or secret-like path"));
      continue;
    }
    if (pin.kind === "file" && isProviderInstruction(pin.path)) {
      if (options.includeProviderInstructions === false) {
        entries.push(omittedEntry(
          pin.path,
          "provider_managed_instruction",
          "provider-managed instruction is not attached",
          "instruction",
        ));
      }
      continue;
    }
    if (pin.kind === "folder") {
      const prefix = `${pin.path}/`;
      const matches = pin.path === "."
        ? available
        : available.filter((path) => path.startsWith(prefix));
      const attachableMatches = matches.filter((path) => !isProviderInstruction(path));
      if (matches.length === 0) {
        entries.push(omittedEntry(pin.path, "aldunis_folder", "folder is empty, ignored, missing, or outside the repository", "folder"));
        continue;
      }
      for (const path of attachableMatches) selected.set(path, "aldunis_folder");
      continue;
    }
    if (!availableSet.has(pin.path)) {
      entries.push(omittedEntry(pin.path, "aldunis_attachment", "file is ignored, missing, or outside the repository"));
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
      entries.push(omittedEntry(path, source, "submodule, nested repository, or unsupported entry"));
      continue;
    }
    if (inspectedBytes + direct.size > MAX_CONTEXT_PACKAGE_BYTES) {
      entries.push(omittedEntry(path, source, "package byte limit"));
      continue;
    }
    inspectedBytes += direct.size;
    const canonical = await constrainPath(worktree, join(worktree, path));
    const bytes = await readFile(canonical);
    if (bytes.length !== direct.size) {
      entries.push(omittedEntry(path, source, "file changed during resolution"));
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const mediaType = IMAGE_TYPES[extname(path).toLocaleLowerCase()];
    if (mediaType) {
      attachments.push({ path, kind: "image", mediaType, size: bytes.length });
      entries.push({
        path, type: "image", source, bytes: bytes.length, truncated: false,
        digest, omissionReason: null,
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
      path, type: "text", source, bytes: bytes.length, truncated: false,
      digest, omissionReason: null,
    });
    totalBytes += bytes.length;
  }
  if (pathIndex < paths.length) {
    const limit = attachments.length >= MAX_CONTEXT_PACKAGE_FILES
      ? "package file limit"
      : "package inspection limit";
    entries.push(omittedEntry(
      `${paths.length - pathIndex} additional files`,
      "aldunis_folder",
      limit,
      "folder",
    ));
  }

  if (options.includeProviderInstructions !== false) {
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
): Promise<RepositoryFileResult> {
  try {
    const direct = await lstat(join(worktree, path));
    if (direct.isSymbolicLink()) {
      return { path, kind: "inaccessible", size: null, match };
    }
    const canonical = await constrainPath(worktree, join(worktree, path));
    const details = await stat(canonical);
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
    const bytes = await readFile(canonical);
    return {
      path,
      kind: bytes.includes(0) ? "binary" : "text",
      size: details.size,
      match,
    };
  } catch {
    return { path, kind: "inaccessible", size: null, match };
  }
}

export async function searchRepositoryFiles(
  worktree: string,
  query: string,
  limit = 20,
): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const needle = query.trim().toLocaleLowerCase();
  return (await repositoryPaths(worktree))
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
): Promise<{ files: RepositoryFileResult[]; truncated: boolean }> {
  const needle = query.trim().toLocaleLowerCase();
  const paths = await repositoryPaths(worktree, signal);
  const matches: Array<{ path: string; match: RepositoryFileResult["match"] }> = [];
  let searchedBytes = 0;
  let searchBudgetExhausted = false;
  for (const path of paths) {
    if (signal?.aborted) throw signal.reason;
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
      const bytes = await readFile(canonical);
      searchedBytes += bytes.length;
      if (!bytes.includes(0) && bytes.toString("utf8").toLocaleLowerCase().includes(needle)) {
        matches.push({ path, match: "content" });
      }
    } catch {
      // Inaccessible and racing files remain discoverable only through a name match.
    }
  }
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const selected = matches.slice(0, boundedLimit);
  return {
    files: await Promise.all(selected.map(({ path, match }) => (
      inspectRepositoryFile(worktree, path, match)
    ))),
    truncated: matches.length > selected.length
      || searchBudgetExhausted,
  };
}

export async function previewRepositoryFile(
  worktree: string,
  input: string,
): Promise<RepositoryFilePreview> {
  const path = relativeFilePath(worktree, input);
  assertNotSecretLike(path);
  if (isHidden(path)) throw new RepositoryError("Hidden files are not available for preview.", 403);
  const direct = await lstat(join(worktree, path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new RepositoryError(`${path} is missing or was deleted.`, 404);
    throw new RepositoryError(`${path} is inaccessible.`, 403);
  });
  if (direct.isSymbolicLink()) {
    throw new RepositoryError("Symlinks are not available for preview.", 403);
  }
  const canonical = await constrainPath(worktree, join(worktree, path));
  const details = await stat(canonical);
  if (!details.isFile()) throw new RepositoryError(`${path} is not a file.`);
  const mediaType = IMAGE_TYPES[extname(path).toLocaleLowerCase()] ?? null;
  if (mediaType) {
    if (details.size > MAX_IMAGE_BYTES) {
      return {
        path, kind: "oversized", size: details.size, match: null, mediaType,
        content: null, imageData: null, truncated: false, encoding: "unavailable",
        message: `Image preview exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`,
        attachable: false,
      };
    }
    const bytes = await readFile(canonical);
    return {
      path, kind: "image", size: details.size, match: null, mediaType,
      content: null, imageData: `data:${mediaType};base64,${bytes.toString("base64")}`,
      truncated: false, encoding: "image", message: null, attachable: true,
    };
  }
  const handle = await import("node:fs/promises").then(({ open }) => open(canonical, "r"));
  try {
    const length = Math.min(details.size, MAX_PREVIEW_BYTES);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, 0);
    if (bytes.includes(0)) {
      return {
        path, kind: "binary", size: details.size, match: null, mediaType: null,
        content: null, imageData: null, truncated: false, encoding: "binary",
        message: "Binary files are not rendered as text.", attachable: false,
      };
    }
    const truncated = details.size > MAX_PREVIEW_BYTES;
    return {
      path, kind: truncated ? "oversized" : "text", size: details.size, match: null,
      mediaType: "text/plain", content: bytes.toString("utf8"), imageData: null,
      truncated, encoding: "utf-8",
      message: truncated ? `Preview is truncated at ${MAX_PREVIEW_BYTES / 1024} KB.` : null,
      attachable: details.size <= MAX_TEXT_BYTES,
    };
  } finally {
    await handle.close();
  }
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
  return Promise.all(paths.map(async (input) => {
    const path = relativeFilePath(worktree, input);
    assertNotSecretLike(path);
    if (isHidden(path)) throw new RepositoryError(`${path} is hidden and cannot be attached.`, 403);
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
        throw new RepositoryError(`${path} exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB image limit.`, 413);
      }
      return { path, kind: "image", mediaType, size: details.size };
    }
    if (details.size > MAX_TEXT_BYTES) {
      throw new RepositoryError(`${path} exceeds the ${MAX_TEXT_BYTES / 1024} KB text limit.`, 413);
    }
    const bytes = await readFile(canonical);
    if (bytes.includes(0)) throw new RepositoryError(`${path} is binary and cannot be attached.`);
    totalTextBytes += bytes.length;
    if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
      throw new RepositoryError(`Text context exceeds the ${MAX_TOTAL_TEXT_BYTES / 1024} KB total limit.`, 413);
    }
    return {
      path,
      kind: "text",
      mediaType: "text/plain",
      size: bytes.length,
      content: bytes.toString("utf8"),
    };
  }));
}

function escapeContext(value: string, limit: number): string {
  return value.slice(0, limit)
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
  const context = attachments.map((attachment) => attachment.kind === "text"
    ? `<file path="${attachment.path}">\n${attachment.content}\n</file>`
    : `<image path="${attachment.path}" media-type="${attachment.mediaType}" size="${attachment.size}" />`
  ).concat(elementReferences.slice(0, 3).map((reference) => (
    `<visible-element selector="${escapeContext(reference.selector, 240)}" tag="${escapeContext(reference.tag, 32)}" role="${escapeContext(reference.role ?? "", 80)}" name="${escapeContext(reference.name ?? "", 240)}">${escapeContext(reference.text ?? "", 500)}</visible-element>`
  ))).join("\n\n");
  return `${prompt}\n\n<aldunis-local-context>\n${context}\n</aldunis-local-context>`;
}
