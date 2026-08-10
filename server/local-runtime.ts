const LOCAL_DATABASE_PATH = /(?:^|\/)[^/]+\.(?:db|sqlite|sqlite3)(?:[-.](?:journal|shm|wal))?$/i;
const GENERATED_RUNTIME_PATH =
  /(?:^|\/)data\/(?:[^/]+-state\.json(?:\.[^/]*)?|[^/]+\.state(?:\.[^/]*)?|[^/]+\.lock|[^/]+\.sock(?:\.[^/]*)?)$/i;
/** Local databases and generated data-directory state stay outside user-facing repository surfaces. */
export function isLocalRuntimePath(path: string): boolean {
  return LOCAL_DATABASE_PATH.test(path) || GENERATED_RUNTIME_PATH.test(path);
}

/**
 * Transient image files staged by drag/drop/paste into the composer.
 * Root-level `aldunis-code-composer-images/` only — attachable, but not review surface noise.
 */
export function isComposerAttachmentPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  return (
    normalized === "aldunis-code-composer-images" ||
    normalized.startsWith("aldunis-code-composer-images/")
  );
}
