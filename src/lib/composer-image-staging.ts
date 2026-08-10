import {
  absolutePathForDroppedFile,
  MAX_COMPOSER_IMAGE_BATCH,
  mediaTypeForComposerImage,
  readComposerImagePayload,
  relativePathInsideWorktree,
} from "./composer-images";

export type ComposerImageStageRequest =
  | { root: string; worktree: string; absolutePath: string }
  | {
      root: string;
      worktree: string;
      mediaType: string;
      data: string;
      name: string;
      conversationId: string;
    };

export type ComposerImageStageAdapter = (request: ComposerImageStageRequest) => Promise<string>;

export interface ComposerImageStagingResult {
  paths: string[];
  omitted: number;
  failure: string | null;
}

export async function stageComposerImages({
  files,
  repositoryRoot,
  worktreePath,
  conversationId,
  availablePins,
  stageImage,
}: {
  files: File[];
  repositoryRoot: string | null | undefined;
  worktreePath: string | null | undefined;
  conversationId: string;
  availablePins: number;
  stageImage: ComposerImageStageAdapter;
}): Promise<ComposerImageStagingResult> {
  if (!repositoryRoot || !worktreePath) {
    return {
      paths: [],
      omitted: files.length,
      failure: "Open a repository and worktree before attaching images.",
    };
  }
  const capacity = Math.max(0, Math.floor(availablePins));
  if (capacity === 0) {
    return { paths: [], omitted: files.length, failure: "Pin at most 100 file or folder paths." };
  }

  const batch = files.slice(0, Math.min(capacity, MAX_COMPOSER_IMAGE_BATCH));
  const paths: string[] = [];
  for (const file of batch) {
    try {
      const absolutePath = absolutePathForDroppedFile(file);
      const inTree = absolutePath ? relativePathInsideWorktree(worktreePath, absolutePath) : null;
      const request: ComposerImageStageRequest =
        absolutePath &&
        inTree &&
        /\.(gif|jpe?g|png|webp)$/i.test(inTree) &&
        mediaTypeForComposerImage(file)
          ? { root: repositoryRoot, worktree: worktreePath, absolutePath }
          : await (async () => {
              const payload = await readComposerImagePayload(file);
              return {
                root: repositoryRoot,
                worktree: worktreePath,
                mediaType: payload.mediaType,
                data: payload.data,
                name: payload.name,
                conversationId,
              };
            })();
      const path = await stageImage(request);
      if (path && !paths.includes(path)) paths.push(path);
    } catch (error) {
      return {
        paths,
        omitted: files.length - batch.length,
        failure: error instanceof Error ? error.message : "The image could not be attached.",
      };
    }
  }
  return { paths, omitted: files.length - batch.length, failure: null };
}

export async function stageComposerImageWithHost(
  request: ComposerImageStageRequest,
): Promise<string> {
  const response = await fetch("/api/context/stage-image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = (await response.json()) as {
    attachment?: { path?: string };
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? "The image could not be attached.");
  const path = payload.attachment?.path;
  if (typeof path !== "string" || !path) throw new Error("The image could not be attached.");
  return path;
}
