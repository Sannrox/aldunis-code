/**
 * Path helpers for the project picker, aligned with T3 Code's command-palette
 * browse model (type a path, complete directories, Enter to open).
 */

export function hasTrailingPathSeparator(value: string): boolean {
  return /[\\/]$/.test(value);
}

function getLastPathSeparatorIndex(value: string): number {
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function preferredPathSeparator(value: string): "/" | "\\" {
  if (value.startsWith("/")) return "/";
  return value.includes("\\") ? "\\" : "/";
}

/** True when the query should drive live directory completion. */
export function isFilesystemBrowseQuery(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || trimmed.startsWith(".\\")
    || trimmed.startsWith("..\\")
    || trimmed.startsWith("/")
    || trimmed.startsWith("~/")
    || trimmed === "~"
    || /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

/** Directory whose children should be listed for the current query. */
export function getBrowseDirectoryPath(currentPath: string): string {
  if (hasTrailingPathSeparator(currentPath) || currentPath === "~") {
    return currentPath === "~" ? "~/" : currentPath;
  }
  const lastSeparatorIndex = getLastPathSeparatorIndex(currentPath);
  if (lastSeparatorIndex < 0) return currentPath;
  return currentPath.slice(0, lastSeparatorIndex + 1);
}

/** Incomplete leaf segment used to filter directory names. */
export function getBrowseLeafPathSegment(currentPath: string): string {
  if (hasTrailingPathSeparator(currentPath) || currentPath === "~") return "";
  const lastSeparatorIndex = getLastPathSeparatorIndex(currentPath);
  return currentPath.slice(lastSeparatorIndex + 1);
}

export function appendBrowsePathSegment(currentPath: string, segment: string): string {
  const base = getBrowseDirectoryPath(currentPath);
  const separator = preferredPathSeparator(base.startsWith("~") ? `/${base.slice(1)}` : base);
  const prefix = hasTrailingPathSeparator(base) ? base : `${base}${separator}`;
  return `${prefix}${segment}${separator}`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const trimmed = currentPath.trim();
  if (trimmed === "~" || trimmed === "~/" || trimmed === "/") return null;
  if (trimmed === "~\\") return null;
  const withSlash = hasTrailingPathSeparator(trimmed) ? trimmed.slice(0, -1) : trimmed;
  const lastSeparatorIndex = getLastPathSeparatorIndex(withSlash);
  if (lastSeparatorIndex < 0) return null;
  if (lastSeparatorIndex === 0) return "/";
  if (withSlash.startsWith("~") && lastSeparatorIndex === 1) return "~/";
  return withSlash.slice(0, lastSeparatorIndex + 1);
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

/** Default start for the add-project path input (T3: `~/`). */
export function getAddProjectInitialQuery(): string {
  return "~/";
}
