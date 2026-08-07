const LOCAL_DATABASE_PATH = /(?:^|\/)[^/]+\.(?:db|sqlite|sqlite3)(?:[-.](?:journal|shm|wal))?$/i;
const GENERATED_RUNTIME_PATH =
  /(?:^|\/)data\/(?:[^/]+-state\.json(?:\.[^/]*)?|[^/]+\.state(?:\.[^/]*)?|[^/]+\.lock|[^/]+\.sock(?:\.[^/]*)?)$/i;

/** Local databases and generated data-directory state stay outside user-facing repository surfaces. */
export function isLocalRuntimePath(path: string): boolean {
  return LOCAL_DATABASE_PATH.test(path) || GENERATED_RUNTIME_PATH.test(path);
}
