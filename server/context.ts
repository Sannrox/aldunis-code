import { execFile } from "node:child_process";
import { lstat, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { RepositoryError, constrainPath } from "./repository.ts";

const execFileAsync = promisify(execFile);
export const MAX_CONTEXT_FILES = 8;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_TEXT_BYTES = 256 * 1024;
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

export interface ContextAttachment {
  path: string;
  kind: "text" | "image";
  mediaType: string;
  size: number;
  content?: string;
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
  if (SECRET_NAMES.test(path)) {
    throw new RepositoryError(`${path} looks secret-like and cannot be attached.`, 403);
  }
}

function isHidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
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
    .filter((path) => !isHidden(path) && !SECRET_NAMES.test(path))
    .sort((left, right) => left.localeCompare(right));
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
