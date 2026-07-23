import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { RepositoryError, constrainPath } from "./repository.ts";

const execFileAsync = promisify(execFile);
export const MAX_CONTEXT_FILES = 8;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_TEXT_BYTES = 256 * 1024;
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

export async function searchRepositoryFiles(
  worktree: string,
  query: string,
  limit = 20,
): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const needle = query.trim().toLocaleLowerCase();
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => !SECRET_NAMES.test(path))
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

export function composePrompt(prompt: string, attachments: ContextAttachment[]): string {
  if (attachments.length === 0) return prompt;
  const context = attachments.map((attachment) => attachment.kind === "text"
    ? `<file path="${attachment.path}">\n${attachment.content}\n</file>`
    : `<image path="${attachment.path}" media-type="${attachment.mediaType}" size="${attachment.size}" />`
  ).join("\n\n");
  return `${prompt}\n\n<aldunis-local-context>\n${context}\n</aldunis-local-context>`;
}
