import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";

export const MAX_TLS_MATERIAL_BYTES = 1024 * 1024;

export interface TlsMaterialFileHandle {
  close(): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<BigIntStats>;
}

export interface TlsMaterialFileOperations {
  open(path: string): Promise<TlsMaterialFileHandle>;
}

const tlsMaterialFileOperations: TlsMaterialFileOperations = {
  open: async (path) => {
    const handle = await open(path, "r");
    return {
      close: () => handle.close(),
      read: async (buffer, offset, length, position) => {
        const { bytesRead } = await handle.read(buffer, offset, length, position);
        return { bytesRead };
      },
      stat: () => handle.stat({ bigint: true }),
    };
  },
};

class TlsMaterialError extends Error {}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function readTlsMaterial(
  path: string,
  label: string,
  operations: TlsMaterialFileOperations = tlsMaterialFileOperations,
): Promise<Buffer> {
  let handle: TlsMaterialFileHandle | null = null;
  try {
    handle = await operations.open(path);
    const initial = await handle.stat();
    if (!initial.isFile()) {
      throw new TlsMaterialError(`${label} must be a regular file.`);
    }
    if (initial.size > BigInt(MAX_TLS_MATERIAL_BYTES)) {
      throw new TlsMaterialError(`${label} must be at most ${MAX_TLS_MATERIAL_BYTES / 1024} KiB.`);
    }

    const size = Number(initial.size);
    const bytes = Buffer.allocUnsafe(size);
    let position = 0;
    while (position < size) {
      const requested = size - position;
      const { bytesRead } = await handle.read(bytes, position, requested, position);
      if (bytesRead <= 0 || bytesRead > requested) {
        throw new TlsMaterialError(`${label} changed while it was read.`);
      }
      position += bytesRead;
    }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, position);
    const final = await handle.stat();
    if (extra.bytesRead !== 0 || !sameFile(initial, final)) {
      throw new TlsMaterialError(`${label} changed while it was read.`);
    }

    const completedHandle = handle;
    handle = null;
    try {
      await completedHandle.close();
    } catch {
      throw new TlsMaterialError(`${label} could not be closed after reading.`);
    }
    return bytes;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Cleanup must not replace the primary admission or stability failure.
      }
    }
    if (error instanceof TlsMaterialError) throw error;
    throw new Error(`${label} could not be read.`);
  }
}
