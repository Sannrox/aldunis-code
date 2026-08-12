import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_PERMISSION_HOOK_CONFIG_BYTES,
  PermissionHookConfigError,
  readPermissionHookConfig,
} from "./permission-hook-config.mjs";

function metadata(size: bigint, overrides: Record<string, bigint> = {}) {
  return {
    dev: 1n,
    ino: 2n,
    mode: 0o100600n,
    size,
    mtimeNs: 3n,
    ctimeNs: 4n,
    isFile: () => true,
    ...overrides,
  };
}

test("permission hook config accepts the exact limit and rejects symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-hook-config-"));
  const path = join(directory, "gate.json");
  const link = join(directory, "gate-link.json");
  const bytes = Buffer.alloc(MAX_PERMISSION_HOOK_CONFIG_BYTES, 0x20);
  await writeFile(path, bytes);
  await symlink(path, link);

  assert.equal(readPermissionHookConfig(path), bytes.toString("utf8"));
  assert.throws(
    () => readPermissionHookConfig(link),
    (error: unknown) =>
      error instanceof PermissionHookConfigError && /regular file/.test(error.message),
  );
});

test("permission hook config rejects oversize before opening or reading", () => {
  let opened = false;
  let read = false;
  assert.throws(
    () =>
      readPermissionHookConfig("/gate.json", {
        lstat: () => metadata(BigInt(MAX_PERMISSION_HOOK_CONFIG_BYTES + 1)),
        open: () => {
          opened = true;
          return 1;
        },
        fstat: () => metadata(0n),
        read: () => {
          read = true;
          return 0;
        },
        close: () => {},
      }),
    /64 KiB limit/,
  );
  assert.equal(opened, false);
  assert.equal(read, false);
});

test("permission hook config rejects mutation, short reads, and close failure", () => {
  const bytes = Buffer.from("{}", "utf8");
  let statCalls = 0;
  let closed = 0;
  const operations = {
    lstat: () => metadata(BigInt(bytes.length)),
    open: () => 1,
    fstat: () => {
      statCalls += 1;
      return metadata(BigInt(bytes.length), statCalls > 1 ? { mtimeNs: 9n } : {});
    },
    read: (_handle: number, target: Buffer, offset: number, length: number, position: number) => {
      const count = Math.min(length, Math.max(0, bytes.length - position));
      bytes.copy(target, offset, position, position + count);
      return count;
    },
    close: () => {
      closed += 1;
    },
  };
  assert.throws(() => readPermissionHookConfig("/gate.json", operations), /changed while reading/);
  assert.equal(closed, 1);

  assert.throws(
    () =>
      readPermissionHookConfig("/gate.json", {
        ...operations,
        fstat: () => metadata(BigInt(bytes.length)),
        read: () => 0,
      }),
    /changed while reading/,
  );
  assert.throws(
    () =>
      readPermissionHookConfig("/gate.json", {
        ...operations,
        fstat: () => metadata(BigInt(bytes.length)),
        close: () => {
          throw new Error("close failed");
        },
      }),
    /could not be closed safely/,
  );
});
