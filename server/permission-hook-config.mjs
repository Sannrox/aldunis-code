import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export const MAX_PERMISSION_HOOK_CONFIG_BYTES = 64 * 1024;

export class PermissionHookConfigError extends Error {}

const defaultOperations = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path) => openSync(path, "r"),
  fstat: (handle) => fstatSync(handle, { bigint: true }),
  read: (handle, buffer, offset, length, position) =>
    readSync(handle, buffer, offset, length, position),
  close: (handle) => closeSync(handle),
};

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function readPermissionHookConfig(path, operations = defaultOperations) {
  let handle = null;
  let primaryError = null;
  let content = null;
  try {
    const initialPath = operations.lstat(path);
    if (!initialPath.isFile()) {
      throw new PermissionHookConfigError("configuration must be a regular file");
    }
    if (initialPath.size < 0n || initialPath.size > BigInt(MAX_PERMISSION_HOOK_CONFIG_BYTES)) {
      throw new PermissionHookConfigError("configuration exceeds the 64 KiB limit");
    }

    handle = operations.open(path);
    const initial = operations.fstat(handle);
    if (!initial.isFile() || !sameFile(initialPath, initial)) {
      throw new PermissionHookConfigError("configuration changed while opening");
    }

    const bytes = Buffer.alloc(Number(initial.size));
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = operations.read(handle, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.length - offset) {
        throw new PermissionHookConfigError("configuration changed while reading");
      }
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (operations.read(handle, extra, 0, 1, offset) !== 0) {
      throw new PermissionHookConfigError("configuration changed while reading");
    }

    const final = operations.fstat(handle);
    const finalPath = operations.lstat(path);
    if (!sameFile(initial, final) || !sameFile(final, finalPath)) {
      throw new PermissionHookConfigError("configuration changed while reading");
    }
    content = bytes.toString("utf8");
  } catch (error) {
    primaryError =
      error instanceof PermissionHookConfigError
        ? error
        : new PermissionHookConfigError("configuration could not be read safely");
  }
  if (handle !== null) {
    try {
      operations.close(handle);
    } catch {
      if (!primaryError) {
        primaryError = new PermissionHookConfigError("configuration could not be closed safely");
      }
    }
  }
  if (primaryError) throw primaryError;
  return content;
}
