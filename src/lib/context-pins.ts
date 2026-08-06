/**
 * Return whether a context pin already has the repository-relative shape
 * required by the host. The host remains authoritative for filesystem checks;
 * this guard only prevents an obviously invalid pin from being shown as
 * attached while the asynchronous preview rejects it.
 */
export function isRepositoryRelativeContextPinPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0")) return false;
  if (normalized === ".") return true;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}
