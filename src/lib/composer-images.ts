/** Supported image MIME types for composer drag/drop and paste. */
export const COMPOSER_IMAGE_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;

export type ComposerImageMediaType = (typeof COMPOSER_IMAGE_TYPES)[number];

export const MAX_COMPOSER_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_COMPOSER_IMAGE_BATCH = 8;

const EXTENSION_MEDIA_TYPES: Record<string, ComposerImageMediaType> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const SUPPORTED = new Set<string>(COMPOSER_IMAGE_TYPES);

export function mediaTypeForComposerImage(
  file: Pick<File, "name" | "type">,
): ComposerImageMediaType | null {
  const typed = file.type.trim().toLocaleLowerCase();
  if (SUPPORTED.has(typed)) return typed as ComposerImageMediaType;
  const match = /\.([a-z0-9]+)$/i.exec(file.name ?? "");
  if (!match) return null;
  return EXTENSION_MEDIA_TYPES[`.${match[1].toLocaleLowerCase()}`] ?? null;
}

export function isSupportedComposerImage(file: Pick<File, "name" | "type" | "size">): boolean {
  if (file.size <= 0 || file.size > MAX_COMPOSER_IMAGE_BYTES) return false;
  return mediaTypeForComposerImage(file) !== null;
}

/** Electron may expose an absolute filesystem path on dropped File objects. */
export function absolutePathForDroppedFile(file: File): string | null {
  const path = (file as File & { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

export function relativePathInsideWorktree(worktree: string, absolutePath: string): string | null {
  if (!worktree || !absolutePath) return null;
  const normalizedRoot = worktree.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedPath = absolutePath.replaceAll("\\", "/");
  if (normalizedPath === normalizedRoot) return null;
  const prefix = `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) return null;
  const relative = normalizedPath.slice(prefix.length);
  if (!relative || relative.includes("\0") || relative.split("/").some((part) => part === "..")) {
    return null;
  }
  return relative;
}

function filesFromList(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list);
}

export function collectComposerImageFiles(list: FileList | File[] | null | undefined): {
  images: File[];
  rejected: number;
} {
  const images: File[] = [];
  let rejected = 0;
  for (const file of filesFromList(list)) {
    if (isSupportedComposerImage(file)) images.push(file);
    else rejected += 1;
  }
  return { images, rejected };
}

export function collectComposerImagesFromDataTransfer(dataTransfer: DataTransfer | null): {
  images: File[];
  rejected: number;
} {
  if (!dataTransfer) return { images: [], rejected: 0 };
  if (dataTransfer.files?.length) return collectComposerImageFiles(dataTransfer.files);
  const gathered: File[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) gathered.push(file);
  }
  return collectComposerImageFiles(gathered);
}

export function collectComposerImagesFromClipboard(clipboardData: DataTransfer | null): {
  images: File[];
  rejected: number;
} {
  return collectComposerImagesFromDataTransfer(clipboardData);
}

export function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

export async function readComposerImagePayload(file: File): Promise<{
  mediaType: ComposerImageMediaType;
  data: string;
  name: string;
  size: number;
}> {
  const mediaType = mediaTypeForComposerImage(file);
  if (!mediaType) throw new Error("Only GIF, JPEG, PNG, and WebP images can be attached.");
  if (file.size > MAX_COMPOSER_IMAGE_BYTES) {
    throw new Error(`Images must be at most ${MAX_COMPOSER_IMAGE_BYTES / 1024 / 1024} MB.`);
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) throw new Error("Image data is empty.");
  if (bytes.byteLength > MAX_COMPOSER_IMAGE_BYTES) {
    throw new Error(`Images must be at most ${MAX_COMPOSER_IMAGE_BYTES / 1024 / 1024} MB.`);
  }
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return {
    mediaType,
    data: btoa(binary),
    name: file.name || `image.${mediaType.split("/")[1] ?? "png"}`,
    size: bytes.byteLength,
  };
}
