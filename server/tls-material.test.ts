import assert from "node:assert/strict";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_TLS_MATERIAL_BYTES,
  readTlsMaterial,
  type TlsMaterialFileOperations,
} from "./tls-material.ts";

test("TLS material accepts the exact limit and symlink-mounted secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-tls-material-"));
  const target = join(root, "target.pem");
  const linked = join(root, "linked.pem");
  const bytes = Buffer.alloc(MAX_TLS_MATERIAL_BYTES, 0x61);
  await writeFile(target, bytes);
  await symlink("target.pem", linked);

  assert.deepEqual(await readTlsMaterial(linked, "TLS certificate"), bytes);
  await assert.rejects(
    () => readTlsMaterial(root, "TLS certificate"),
    /TLS certificate must be a regular file/,
  );
});

test("TLS material rejects oversize from descriptor metadata before reading", async () => {
  let read = false;
  let closed = false;
  const operations: TlsMaterialFileOperations = {
    open: async () => ({
      close: async () => {
        closed = true;
      },
      read: async () => {
        read = true;
        return { bytesRead: 0 };
      },
      stat: async () =>
        ({
          isFile: () => true,
          size: BigInt(MAX_TLS_MATERIAL_BYTES + 1),
        }) as BigIntStats,
    }),
  };

  await assert.rejects(
    () => readTlsMaterial("oversized.pem", "TLS private key", operations),
    /TLS private key must be at most 1024 KiB/,
  );
  assert.equal(read, false);
  assert.equal(closed, true);
});

test("TLS material closes and rejects shrink, growth, and same-size mutation", async () => {
  const mutations = {
    shrink: (path: string) => truncate(path, 1),
    growth: (path: string) => writeFile(path, "more", { flag: "a" }),
    mutation: (path: string) => writeFile(path, "changed!"),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const root = await mkdtemp(join(tmpdir(), `aldunis-tls-${name}-`));
    const path = join(root, "material.pem");
    await writeFile(path, "original");
    let closed = false;
    let mutated = false;
    const operations: TlsMaterialFileOperations = {
      open: async (candidate) => {
        const handle = await open(candidate, "r");
        return {
          close: async () => {
            closed = true;
            await handle.close();
          },
          read: async (buffer, offset, length, position) => {
            const result = await handle.read(buffer, offset, length, position);
            if (!mutated) {
              mutated = true;
              await mutate(candidate);
            }
            return { bytesRead: result.bytesRead };
          },
          stat: () => handle.stat({ bigint: true }),
        };
      },
    };

    await assert.rejects(
      () => readTlsMaterial(path, "TLS certificate", operations),
      /TLS certificate changed while it was read/,
    );
    assert.equal(closed, true, `${name} must close the TLS file handle`);
  }
});

test("TLS material rejects short reads and close failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-tls-failures-"));
  const path = join(root, "material.pem");
  await writeFile(path, "material");
  const details = await lstat(path, { bigint: true });
  const shortRead: TlsMaterialFileOperations = {
    open: async () => ({
      close: async () => undefined,
      read: async () => ({ bytesRead: 0 }),
      stat: async () => details,
    }),
  };
  await assert.rejects(
    () => readTlsMaterial(path, "TLS certificate", shortRead),
    /changed while it was read/,
  );

  const closeFailure: TlsMaterialFileOperations = {
    open: async (candidate) => {
      const handle = await open(candidate, "r");
      return {
        close: async () => {
          await handle.close();
          throw new Error("fixture close failure");
        },
        read: async (buffer, offset, length, position) => {
          const { bytesRead } = await handle.read(buffer, offset, length, position);
          return { bytesRead };
        },
        stat: () => handle.stat({ bigint: true }),
      };
    },
  };
  await assert.rejects(
    () => readTlsMaterial(path, "TLS private key", closeFailure),
    /could not be closed after reading/,
  );
});
