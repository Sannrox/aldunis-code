import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleContextPackage,
  browseRepositoryFiles,
  COMPOSER_ATTACHMENT_DIR,
  composePrompt,
  MAX_ACTIVE_BROWSE_INSPECTIONS,
  MAX_COMPOSER_ATTACHMENT_IGNORE_BYTES,
  MAX_CONTEXT_FILES,
  MAX_IMAGE_BYTES,
  MAX_INSPECTED_COMPOSER_ATTACHMENT_ENTRIES,
  previewRepositoryFile,
  readBoundedContextPackageFile,
  readStableWorktreeImage,
  resolveContextAttachments,
  resolveWorktreeImagePath,
  searchRepositoryFiles,
  stageComposerImage,
  stageWorktreeImageCopy,
} from "./context.ts";
import { isComposerAttachmentPath } from "./local-runtime.ts";

test("bounded context-package reads reject an atomic replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-context-package-read-"));
  const source = join(root, "source.txt");
  const replacement = join(root, "replacement.txt");
  await writeFile(source, "small");
  const admitted = await lstat(source);
  await writeFile(replacement, Buffer.alloc(3 * 1024 * 1024, 0x61));
  await rename(replacement, source);

  assert.equal(await readBoundedContextPackageFile(source, admitted, MAX_IMAGE_BYTES), null);
});

test("stable image reads bound each cancellation interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-image-read-cancel-"));
  const source = join(root, "image.png");
  await writeFile(source, Buffer.alloc(2 * 64 * 1024));
  const canonical = await realpath(source);
  const controller = new AbortController();
  let maximumRead = 0;
  let closed = false;
  await assert.rejects(
    readStableWorktreeImage(
      canonical,
      "image.png",
      {
        open: async (path, flags) => {
          const handle = await open(path, flags);
          return {
            stat: handle.stat.bind(handle),
            read: async (buffer, offset, length, position) => {
              maximumRead = Math.max(maximumRead, length);
              const result = await handle.read(buffer, offset, length, position);
              controller.abort();
              return result;
            },
            close: async () => {
              closed = true;
              await handle.close();
            },
          };
        },
        lstat,
      },
      controller.signal,
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(maximumRead, 64 * 1024);
  assert.equal(closed, true);
});

test("bounded context-package reads treat pathname disappearance as changed input", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-context-package-read-"));
  const source = join(root, "source.txt");
  const content = Buffer.from("small");
  await writeFile(source, content);
  const admitted = await lstat(source);
  let reads = 0;

  assert.equal(
    await readBoundedContextPackageFile(source, admitted, MAX_IMAGE_BYTES, undefined, {
      async open() {
        return {
          async stat() {
            return admitted;
          },
          async read(buffer: Buffer, offset: number) {
            reads += 1;
            if (reads === 1) content.copy(buffer, offset);
            return { bytesRead: reads === 1 ? content.length : 0, buffer };
          },
          async close() {},
        };
      },
      async lstat() {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    }),
    null,
  );
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "aldunis-context-"));
  const root = join(parent, "repository");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "auth"));
  await writeFile(join(root, "src", "main.ts"), "export const ready = true;\n");
  await writeFile(join(root, "src", "sidebar-state.ts"), "export const sidebarState = true;\n");
  await writeFile(join(root, "auth", "login.ts"), "export const login = true;\n");
  await writeFile(join(root, "auth-token.ts"), "export const authToken = true;\n");
  await writeFile(join(root, ".env"), "TOKEN=secret\n");
  await writeFile(join(root, "credentials.yaml"), "token: secret\n");
  await writeFile(join(root, "api-key.yml"), "api_key: secret\n");
  await writeFile(join(root, "password.conf"), "password=secret\n");
  await writeFile(join(root, "secret.toml"), 'token = "secret"\n');
  await writeFile(join(root, "credentials.json.bak"), '{"token":"secret"}\n');
  await writeFile(join(root, "token.env.backup"), "TOKEN=secret\n");
  await writeFile(join(root, "secret.yaml.old"), "token: secret\n");
  await writeFile(join(root, "api-token.json.local"), '{"token":"secret"}\n');
  await writeFile(join(root, "secret.yaml.production"), "token: secret\n");
  await writeFile(join(root, "auth.env.private"), "TOKEN=secret\n");
  await writeFile(join(root, "auth.config.ts"), "export const authConfig = true;\n");
  await writeFile(join(root, "token.json.ts"), "export const tokenConfig = true;\n");
  await writeFile(join(root, "api-key.config.js"), "export const apiKeyConfig = true;\n");
  await writeFile(join(root, "id_ed25519.pub"), "ssh-ed25519 public-key\n");
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "sekai.sock.gateway-token"), "gateway-secret-token\n");
  await writeFile(join(root, "data", "sekai.db"), Buffer.from([1, 2, 3]));
  await writeFile(join(root, "data", "provider-registry-state.json"), "{}\n");
  await writeFile(join(root, "data", "provider-registry-state.json.initialized"), "true\n");
  await writeFile(join(root, "data", "provider-registry-state.json.lock"), "lock\n");
  await writeFile(join(root, "data", "sidebar-state.ts"), "export const dataState = true;\n");
  await writeFile(join(root, "data", "state-machine-state.md"), "documented state\n");
  await writeFile(join(root, "data", "a.db"), Buffer.from([1, 0, 3]));
  await writeFile(join(root, "data", "[a].db"), Buffer.from([1, 2, 3]));
  await writeFile(join(root, "data", "tracked-fixture.db"), Buffer.from([1, 2, 3]));
  await writeFile(join(root, "runtime.sqlite"), Buffer.from([1, 2, 3]));
  await writeFile(join(root, "runtime.sqlite-wal"), Buffer.from([1, 2, 3]));
  await writeFile(join(root, "runtime.sqlite-journal"), Buffer.from([1, 2, 3]));
  await writeFile(join(root, "data", "session-state.json"), "{}\n");
  await writeFile(join(root, "data", "session.lock"), "lock\n");
  await writeFile(join(root, "yarn.lock"), "fixture lockfile\n");
  await mkdir(join(root, "secret"));
  await writeFile(join(root, "secret", "config.json"), '{"token":"secret"}\n');
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, "secrets", "clientSecret.json"), '{"value":"secret"}\n');
  await writeFile(join(root, "tokens.yaml"), "access_token: secret\n");
  await writeFile(join(root, "apiToken.txt"), "secret\n");
  await mkdir(join(root, "design-tokens"));
  await writeFile(join(root, "design-tokens", "theme.css"), ":root { --color-token: red; }\n");
  await writeFile(join(root, "tokenizer.ts"), "export const tokenize = true;\n");
  await writeFile(join(root, "token-table.md"), "| token | value |\n");
  await writeFile(join(root, "designTokens.ts"), "export const designTokens = {};\n");
  await writeFile(join(root, "src", "secret-manager.ts"), "export const manager = true;\n");
  await writeFile(join(root, "secret_store.go"), "package secret_store\n");
  await writeFile(join(root, "oauth-token-flow.md"), "OAuth token flow documentation\n");
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "secret-handling.md"), "Secret handling guidance\n");
  await writeFile(join(root, "clientSecret.json.example"), "{}\n");
  await writeFile(join(root, "api-token.txt.template"), "token=\n");
  await writeFile(join(root, "oauth-token.json.md"), "OAuth token format\n");
  await writeFile(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
  await writeFile(
    join(root, "image.png"),
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]),
  );
  await writeFile(join(root, "oversized.txt"), "x".repeat(64 * 1024 + 1));
  await writeFile(join(root, "preview-truncated.txt"), "y".repeat(128 * 1024 + 1));
  await writeFile(join(root, "notes.txt"), "bounded content search target\n");
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, ".hidden", "notes.txt"), "target must stay hidden\n");
  await mkdir(join(root, "generated"));
  await writeFile(join(root, "generated", "output.txt"), "target must stay ignored\n");
  await writeFile(join(root, ".gitignore"), "generated/\n");
  await import("node:child_process").then(
    ({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["init", "-q", root], (error) => (error ? reject(error) : resolve()));
      }),
  );
  await import("node:child_process").then(
    ({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile(
          "git",
          ["-C", root, "add", "--", "data/a.db", "data/tracked-fixture.db"],
          (error) => (error ? reject(error) : resolve()),
        );
      }),
  );
  return { parent, root };
}

test("file discovery is repository-scoped and hides protected names", async () => {
  const { root } = await fixture();
  assert.deepEqual(await searchRepositoryFiles(root, "main"), ["src/main.ts"]);
  const files = await searchRepositoryFiles(root, "", 50);
  assert.equal(files.includes(".env"), false);
  assert.equal(files.includes("data/sekai.sock.gateway-token"), false);
  assert.equal(files.includes("src/sidebar-state.ts"), true);
  assert.equal(files.includes("data/sidebar-state.ts"), true);
  assert.equal(files.includes("data/state-machine-state.md"), true);
  assert.equal(files.includes("yarn.lock"), true);
  assert.equal(files.includes("data/a.db"), true);
  assert.equal(files.includes("data/[a].db"), false);
  assert.equal(files.includes("data/tracked-fixture.db"), true);
  for (const runtimePath of [
    "data/sekai.db",
    "data/provider-registry-state.json",
    "data/provider-registry-state.json.initialized",
    "data/provider-registry-state.json.lock",
    "runtime.sqlite",
    "runtime.sqlite-wal",
    "runtime.sqlite-journal",
    "data/session-state.json",
    "data/session.lock",
  ]) {
    assert.equal(files.includes(runtimePath), false, runtimePath);
  }
  assert.equal(files.includes("secret/config.json"), false);
  assert.equal(files.includes("secrets/clientSecret.json"), false);
  assert.equal(files.includes("tokens.yaml"), false);
  assert.equal(files.includes("apiToken.txt"), false);
  assert.deepEqual(await searchRepositoryFiles(root, "gateway-token"), []);
  assert.deepEqual(await searchRepositoryFiles(root, "login"), ["auth/login.ts"]);
  assert.deepEqual(await searchRepositoryFiles(root, "auth-token.ts"), ["auth-token.ts"]);
  assert.deepEqual(await searchRepositoryFiles(root, "id_ed25519"), ["id_ed25519.pub"]);
  for (const secretPath of [
    "credentials.yaml",
    "api-key.yml",
    "password.conf",
    "secret.toml",
    "credentials.json.bak",
    "token.env.backup",
    "secret.yaml.old",
    "api-token.json.local",
    "secret.yaml.production",
    "auth.env.private",
  ]) {
    assert.deepEqual(await searchRepositoryFiles(root, secretPath), []);
  }
  assert.equal(files.includes("design-tokens/theme.css"), true);
  assert.equal(files.includes("tokenizer.ts"), true);
  assert.equal(files.includes("token-table.md"), true);
  assert.equal(files.includes("designTokens.ts"), true);
  assert.equal(files.includes("src/secret-manager.ts"), true);
  assert.equal(files.includes("secret_store.go"), true);
  assert.equal(files.includes("oauth-token-flow.md"), true);
  assert.equal(files.includes("docs/secret-handling.md"), true);
  assert.equal(files.includes("clientSecret.json.example"), true);
  assert.equal(files.includes("api-token.txt.template"), true);
  assert.equal(files.includes("oauth-token.json.md"), true);
  assert.equal(files.includes("auth.config.ts"), true);
  assert.equal(files.includes("token.json.ts"), true);
  assert.equal(files.includes("api-key.config.js"), true);
});

test("file discovery cancels both Git listings through the request signal", async () => {
  const { root } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchRepositoryFiles(root, "main", 20, controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("context package assembly cancels Git discovery through its request signal", async () => {
  const { root } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    assembleContextPackage(root, [{ path: ".", kind: "folder" }], {
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("browsing searches names and bounded text deterministically", async () => {
  const { root } = await fixture();
  const byName = await browseRepositoryFiles(root, "main");
  assert.deepEqual(
    byName.files.map(({ path, match }) => ({ path, match })),
    [{ path: "src/main.ts", match: "name" }],
  );
  const byContent = await browseRepositoryFiles(root, "search target");
  assert.deepEqual(
    byContent.files.map(({ path, match }) => ({ path, match })),
    [{ path: "notes.txt", match: "content" }],
  );
  assert.equal(
    byContent.files.some(({ path }) => path.startsWith(".")),
    false,
  );
  assert.equal((await browseRepositoryFiles(root, "target must stay ignored")).files.length, 0);
  assert.deepEqual((await browseRepositoryFiles(root, "gateway-token")).files, []);
  assert.deepEqual((await browseRepositoryFiles(root, "sekai.db")).files, []);
  assert.deepEqual((await browseRepositoryFiles(root, "provider-registry-state")).files, []);
  assert.deepEqual((await browseRepositoryFiles(root, "runtime.sqlite")).files, []);
  assert.deepEqual((await browseRepositoryFiles(root, "session-state")).files, []);
  assert.deepEqual((await browseRepositoryFiles(root, "session.lock")).files, []);
  assert.deepEqual(
    (await browseRepositoryFiles(root, "login")).files.map(({ path }) => path),
    ["auth/login.ts"],
  );
  assert.deepEqual(
    (await browseRepositoryFiles(root, "auth-token.ts")).files.map(({ path }) => path),
    ["auth-token.ts"],
  );
  assert.deepEqual((await browseRepositoryFiles(root, "credentials")).files, []);
});

test("repository browse bounds parallel inspections and preserves result order", async () => {
  const { root } = await fixture();
  let active = 0;
  let maximumActive = 0;
  const result = await browseRepositoryFiles(root, "", undefined, 200, {
    open,
    lstat,
    inspectRepositoryFile: async (_worktree, path, match, signal) => {
      signal?.throwIfAborted();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { path, kind: "text", size: path.length, match };
    },
  });
  assert.equal(maximumActive, MAX_ACTIVE_BROWSE_INSPECTIONS);
  assert.deepEqual(
    result.files.map(({ path }) => path),
    [...result.files.map(({ path }) => path)].sort(),
  );
});

test("repository browse cancellation stops queued inspections", async () => {
  const { root } = await fixture();
  const controller = new AbortController();
  let started = 0;
  let releaseInspections: () => void = () => undefined;
  const inspectionsReleased = new Promise<void>((resolve) => {
    releaseInspections = resolve;
  });
  let confirmWorkersStarted: () => void = () => undefined;
  const workersStarted = new Promise<void>((resolve) => {
    confirmWorkersStarted = resolve;
  });
  const browsing = browseRepositoryFiles(root, "", controller.signal, 200, {
    open,
    lstat,
    inspectRepositoryFile: async (_worktree, path, match) => {
      started += 1;
      if (started === MAX_ACTIVE_BROWSE_INSPECTIONS) confirmWorkersStarted();
      await inspectionsReleased;
      return { path, kind: "text", size: path.length, match };
    },
  });
  await workersStarted;
  controller.abort();
  releaseInspections();
  await assert.rejects(
    browsing,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(started, MAX_ACTIVE_BROWSE_INSPECTIONS);
});

test("repository content search forwards and preserves read cancellation", async () => {
  const { root } = await fixture();
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  await assert.rejects(
    browseRepositoryFiles(root, "absent-content-query", controller.signal, 100, {
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          stat: async () => {
            receivedSignal = controller.signal;
            controller.abort();
            return handle.stat();
          },
          read: handle.read.bind(handle),
          close: handle.close.bind(handle),
        };
      },
      lstat,
      inspectRepositoryFile: async () => {
        throw new Error("Canceled content search must not inspect results.");
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(receivedSignal, controller.signal);
});

test("repository content search rejects an oversized atomic replacement before reading", async () => {
  const { root } = await fixture();
  const target = join(root, "notes.txt");
  const replacement = join(root, "replacement.txt");
  await writeFile(replacement, Buffer.alloc(2 * MAX_IMAGE_BYTES));
  let openedFlags = 0;
  let reads = 0;
  const result = await browseRepositoryFiles(root, "absent-content-query", undefined, 100, {
    open: async (path, flags) => {
      const isTarget = path.endsWith("/notes.txt");
      if (isTarget) {
        openedFlags = flags;
        await rename(replacement, target);
      }
      const handle = await open(path, flags);
      return {
        stat: handle.stat.bind(handle),
        read: async (...args: Parameters<typeof handle.read>) => {
          if (isTarget) reads += 1;
          return handle.read(...args);
        },
        close: handle.close.bind(handle),
      };
    },
    lstat,
    inspectRepositoryFile: async () => {
      throw new Error("Rejected replacement must not produce a result.");
    },
  });
  assert.equal(result.files.length, 0);
  assert.equal(reads, 0);
  assert.equal((openedFlags & constants.O_NONBLOCK) !== 0, true);
  assert.equal((openedFlags & constants.O_NOFOLLOW) !== 0, true);
});

test("content search reports when its byte budget makes results incomplete", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "bulk"));
  await Promise.all(
    Array.from({ length: 33 }, (_, index) =>
      writeFile(
        join(root, "bulk", `${String(index).padStart(2, "0")}.txt`),
        "x".repeat(128 * 1024),
      ),
    ),
  );
  await writeFile(join(root, "z-tail.txt"), "late unique content");
  const result = await browseRepositoryFiles(root, "late unique content");
  assert.equal(result.files.length, 0);
  assert.equal(result.truncated, true);
});

test("preview reports text, images, binary, truncation, missing, and symlinks explicitly", async () => {
  const { parent, root } = await fixture();
  const text = await previewRepositoryFile(root, "src/main.ts");
  assert.equal(text.encoding, "utf-8");
  assert.equal(text.attachable, true);
  assert.match(text.content ?? "", /ready/);
  assert.equal((await previewRepositoryFile(root, "image.png")).attachable, true);
  assert.equal((await previewRepositoryFile(root, "binary.dat")).attachable, false);
  assert.equal((await previewRepositoryFile(root, "data/a.db")).kind, "binary");
  assert.equal((await previewRepositoryFile(root, "oversized.txt")).attachable, false);
  const truncated = await previewRepositoryFile(root, "preview-truncated.txt");
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.attachable, false);
  assert.match(truncated.message ?? "", /truncated/);
  await assert.rejects(() => previewRepositoryFile(root, "missing.ts"), /missing or was deleted/);
  await assert.rejects(
    () => previewRepositoryFile(root, "data/sekai.sock.gateway-token"),
    /secret-like/,
  );
  await assert.rejects(() => previewRepositoryFile(root, "data/sekai.db"), /local runtime state/);
  await assert.rejects(
    () => previewRepositoryFile(root, "data/provider-registry-state.json"),
    /local runtime state/,
  );
  await assert.rejects(() => previewRepositoryFile(root, "data/[a].db"), /local runtime state/);
  await assert.rejects(
    () => previewRepositoryFile(root, "runtime.sqlite-journal"),
    /local runtime state/,
  );
  await writeFile(join(parent, "outside.txt"), "outside");
  await symlink(join(parent, "outside.txt"), join(root, "linked-preview.txt"));
  await assert.rejects(() => previewRepositoryFile(root, "linked-preview.txt"), /Symlinks/);
});

test("preview rejects an already cancelled filesystem read", async () => {
  const { root } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    previewRepositoryFile(root, "image.png", controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await assert.rejects(
    previewRepositoryFile(root, "src/main.ts", controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("preview forwards image cancellation and closes a cancelled text handle", async () => {
  const { root } = await fixture();
  const imageController = new AbortController();
  let imageSignal: AbortSignal | undefined;
  await assert.rejects(
    previewRepositoryFile(
      root,
      "image.png",
      imageController.signal,
      { open },
      {
        open: async (path, flags) => {
          imageSignal = imageController.signal;
          const handle = await open(path, flags);
          return {
            stat: async () => {
              imageController.abort();
              return handle.stat();
            },
            read: handle.read.bind(handle),
            close: handle.close.bind(handle),
          };
        },
        lstat,
      },
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(imageSignal, imageController.signal);

  const textController = new AbortController();
  let closed = false;
  await assert.rejects(
    previewRepositoryFile(root, "src/main.ts", textController.signal, {
      open: async () => ({
        read: async () => {
          textController.abort();
          return { bytesRead: 0, buffer: Buffer.alloc(0) };
        },
        close: async () => {
          closed = true;
        },
      }),
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(closed, true);
});

test("image preview rejects an oversized atomic replacement before reading or encoding", async () => {
  const { root } = await fixture();
  const target = join(root, "image.png");
  const replacement = join(root, "replacement.png");
  await writeFile(replacement, Buffer.alloc(2 * MAX_IMAGE_BYTES));
  let openedFlags = 0;
  let reads = 0;
  await assert.rejects(
    previewRepositoryFile(
      root,
      "image.png",
      undefined,
      { open },
      {
        open: async (path, flags) => {
          openedFlags = flags;
          await rename(replacement, target);
          const handle = await open(path, flags);
          return {
            stat: handle.stat.bind(handle),
            read: async (...args: Parameters<typeof handle.read>) => {
              reads += 1;
              return handle.read(...args);
            },
            close: handle.close.bind(handle),
          };
        },
        lstat,
      },
    ),
    /exceeds the 2 MB image limit/,
  );
  assert.equal(reads, 0);
  assert.equal((openedFlags & constants.O_NONBLOCK) !== 0, true);
  assert.equal((openedFlags & constants.O_NOFOLLOW) !== 0, true);
});

test("text and supported images resolve into bounded local context", async () => {
  const { root } = await fixture();
  const attachments = await resolveContextAttachments(root, [
    "src/main.ts",
    "auth-token.ts",
    "id_ed25519.pub",
    "image.png",
  ]);
  assert.deepEqual(
    attachments.map(({ path, kind }) => ({ path, kind })),
    [
      { path: "src/main.ts", kind: "text" },
      { path: "auth-token.ts", kind: "text" },
      { path: "id_ed25519.pub", kind: "text" },
      { path: "image.png", kind: "image" },
    ],
  );
  const prompt = composePrompt("Review this.", attachments);
  assert.match(prompt, /export const ready/);
  assert.match(prompt, /<image path="image.png"/);
});

test("context packages resolve folders deterministically and retain metadata only", async () => {
  const { parent, root } = await fixture();
  const runtime = await assembleContextPackage(root, [{ path: "data/sekai.db", kind: "file" }]);
  assert.deepEqual(runtime.attachments, []);
  assert.equal(runtime.entries[0]?.omissionReason, "ignored, secret-like, or local runtime path");
  await writeFile(join(root, "AGENTS.md"), "# provider-owned instructions\n");
  await writeFile(join(parent, "outside.txt"), "outside");
  await symlink(join(parent, "outside.txt"), join(root, "src", "linked.txt"));
  const assembled = await assembleContextPackage(root, [
    { path: "src", kind: "folder" },
    { path: "generated", kind: "folder" },
  ]);
  assert.deepEqual(
    assembled.attachments.map((attachment) => attachment.path),
    ["src/main.ts", "src/secret-manager.ts", "src/sidebar-state.ts"],
  );
  assert.equal(assembled.entries.find((entry) => entry.path === "src/main.ts")?.digest?.length, 64);
  assert.equal(
    assembled.entries.find((entry) => entry.path === "src/linked.txt")?.omissionReason,
    "symlink",
  );
  assert.match(
    assembled.entries.find((entry) => entry.path === "generated")?.omissionReason ?? "",
    /ignored/,
  );
  assert.equal(
    assembled.entries.find((entry) => entry.path === "AGENTS.md")?.source,
    "provider_managed_instruction",
  );
  assert.equal(JSON.stringify(assembled.entries).includes("export const ready"), false);
  assert.equal(
    assembled.totalBytes,
    Buffer.byteLength("export const ready = true;\n") +
      Buffer.byteLength("export const manager = true;\n") +
      Buffer.byteLength("export const sidebarState = true;\n"),
  );
  assert.equal(assembled.estimatedTokens, Math.ceil(assembled.totalBytes / 4));
});

test("context package paths fail closed outside the repository", async () => {
  const { root } = await fixture();
  await assert.rejects(
    () => assembleContextPackage(root, [{ path: "../outside", kind: "folder" }]),
    /escapes/,
  );
  await assert.rejects(
    () => assembleContextPackage(root, [{ path: "/tmp", kind: "folder" }]),
    /repository-relative/,
  );
});

test("the repository root is a valid folder pin", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "AGENTS.md"), "# provider-owned instructions\n");
  const assembled = await assembleContextPackage(root, [{ path: ".", kind: "folder" }]);
  assert.equal(assembled.pins[0]?.path, ".");
  assert.equal(
    assembled.entries.some((entry) => entry.path === "src/main.ts"),
    true,
  );
  assert.equal(
    assembled.entries.some((entry) => entry.path === "image.png"),
    true,
  );
  assert.equal(
    assembled.entries.some((entry) => entry.path === "auth/login.ts"),
    true,
  );
  assert.equal(
    assembled.attachments.some((attachment) => attachment.path === "AGENTS.md"),
    false,
  );
  assert.equal(
    assembled.entries.find((entry) => entry.path === "AGENTS.md")?.source,
    "provider_managed_instruction",
  );
});

test("context packages enforce deterministic file and byte limits", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "many"));
  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      writeFile(join(root, "many", `${String(index).padStart(3, "0")}.txt`), `${index}`),
    ),
  );
  const fileLimited = await assembleContextPackage(root, [{ path: "many", kind: "folder" }]);
  assert.equal(fileLimited.attachments.length, 100);
  assert.equal(
    fileLimited.entries.some((entry) => entry.omissionReason === "package file limit"),
    true,
  );

  await mkdir(join(root, "rejected-first"));
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      writeFile(
        join(root, "rejected-first", `a-${String(index).padStart(3, "0")}.bin`),
        Buffer.from([0]),
      ),
    ),
  );
  await writeFile(join(root, "rejected-first", "z-valid.txt"), "valid");
  const rejectedFirst = await assembleContextPackage(root, [
    { path: "rejected-first", kind: "folder" },
  ]);
  assert.deepEqual(
    rejectedFirst.attachments.map((attachment) => attachment.path),
    ["rejected-first/z-valid.txt"],
  );
  assert.equal(
    rejectedFirst.entries.filter((entry) => entry.omissionReason === "unsupported binary file")
      .length,
    100,
  );

  await mkdir(join(root, "inspection-bound"));
  await Promise.all(
    Array.from({ length: 201 }, (_, index) =>
      writeFile(
        join(root, "inspection-bound", `a-${String(index).padStart(3, "0")}.bin`),
        Buffer.from([0]),
      ),
    ),
  );
  await writeFile(join(root, "inspection-bound", "z-valid.txt"), "too late");
  const inspectionBound = await assembleContextPackage(root, [
    { path: "inspection-bound", kind: "folder" },
  ]);
  const inspectedFolderEntries = inspectionBound.entries.filter(
    (entry) => entry.source === "aldunis_folder",
  );
  assert.equal(inspectionBound.attachments.length, 0);
  assert.equal(inspectedFolderEntries.length, 201);
  const inspectionLimitEntry = inspectedFolderEntries.find(
    (entry) => entry.omissionReason === "package inspection limit",
  );
  assert.equal(inspectionLimitEntry?.path, "2 additional files");

  await mkdir(join(root, "large"));
  await writeFile(join(root, "large", "a.txt"), "a".repeat(1_100_000));
  await writeFile(join(root, "large", "b.txt"), "b".repeat(1_100_000));
  const byteLimited = await assembleContextPackage(root, [{ path: "large", kind: "folder" }]);
  assert.deepEqual(
    byteLimited.attachments.map((attachment) => attachment.path),
    ["large/a.txt"],
  );
  assert.equal(
    byteLimited.entries.find((entry) => entry.path === "large/b.txt")?.omissionReason,
    "package byte limit",
  );

  await mkdir(join(root, "binary"));
  await writeFile(join(root, "binary", "a.bin"), Buffer.alloc(1_100_000));
  await writeFile(join(root, "binary", "b.bin"), Buffer.alloc(1_100_000));
  const binaryLimited = await assembleContextPackage(root, [{ path: "binary", kind: "folder" }]);
  assert.equal(
    binaryLimited.entries.find((entry) => entry.path === "binary/a.bin")?.omissionReason,
    "unsupported binary file",
  );
  assert.equal(
    binaryLimited.entries.find((entry) => entry.path === "binary/b.bin")?.omissionReason,
    "package byte limit",
  );
});

test("remote context assembly does not enumerate provider instruction paths", async () => {
  const { root } = await fixture();
  await writeFile(join(root, "AGENTS.md"), "# provider-owned instructions\n");
  const assembled = await assembleContextPackage(root, [], {
    includeProviderInstructions: false,
  });
  assert.deepEqual(assembled.entries, []);
});

test("visible element references compose as bounded escaped structured context", () => {
  const prompt = composePrompt(
    "Explain this.",
    [],
    [
      {
        selector: "main > button:nth-of-type(1)",
        tag: "button",
        role: "button",
        name: `Save "draft"`,
        text: "<untrusted> page text",
      },
    ],
  );
  assert.match(prompt, /<visible-element/);
  assert.match(prompt, /Save &quot;draft&quot;/);
  assert.match(prompt, /&lt;untrusted&gt; page text/);
  assert.doesNotMatch(prompt, /<untrusted>/);
});

test("missing, binary, oversized, secret-like, excessive, and escaping inputs fail explicitly", async () => {
  const { parent, root } = await fixture();
  await assert.rejects(
    () => resolveContextAttachments(root, ["missing.ts"]),
    /missing or was deleted/,
  );
  await assert.rejects(() => resolveContextAttachments(root, ["binary.dat"]), /binary/);
  await assert.rejects(() => resolveContextAttachments(root, ["oversized.txt"]), /exceeds/);
  await assert.rejects(() => resolveContextAttachments(root, [".env"]), /secret-like/);
  await assert.rejects(
    () => resolveContextAttachments(root, ["data/sekai.sock.gateway-token"]),
    /secret-like/,
  );
  await assert.rejects(
    () => resolveContextAttachments(root, ["data/sekai.db"]),
    /local runtime state/,
  );
  await assert.rejects(
    () => resolveContextAttachments(root, ["data/session-state.json"]),
    /local runtime state/,
  );
  await assert.rejects(
    () => resolveContextAttachments(root, ["data/[a].db"]),
    /local runtime state/,
  );
  for (const secretPath of [
    "credentials.yaml",
    "api-key.yml",
    "password.conf",
    "secret.toml",
    "credentials.json.bak",
    "token.env.backup",
    "secret.yaml.old",
    "api-token.json.local",
    "secret.yaml.production",
    "auth.env.private",
  ]) {
    await assert.rejects(() => resolveContextAttachments(root, [secretPath]), /secret-like/);
  }
  await assert.rejects(
    () => resolveContextAttachments(root, ["secret/config.json"]),
    /secret-like/,
  );
  await assert.rejects(
    () => resolveContextAttachments(root, ["secrets/clientSecret.json"]),
    /secret-like/,
  );
  await assert.rejects(() => resolveContextAttachments(root, ["tokens.yaml"]), /secret-like/);
  await assert.rejects(() => resolveContextAttachments(root, ["apiToken.txt"]), /secret-like/);
  await assert.rejects(
    () =>
      resolveContextAttachments(
        root,
        Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, index) => `${index}.ts`),
      ),
    /Attach at most/,
  );
  await writeFile(join(parent, "outside.txt"), "outside");
  await symlink(join(parent, "outside.txt"), join(root, "linked.txt"));
  await assert.rejects(() => resolveContextAttachments(root, ["linked.txt"]), /symlink/);
});

test("stageComposerImage writes bounded attachable images under aldunis-code-composer-images", async () => {
  const { root } = await fixture();
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const staged = await stageComposerImage(root, {
    mediaType: "image/png",
    data: png.toString("base64"),
    name: "shot.png",
    conversationId: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(staged.mediaType, "image/png");
  assert.ok(
    staged.path.startsWith("aldunis-code-composer-images/11111111-1111-1111-1111-111111111111/"),
  );
  assert.equal(isComposerAttachmentPath(staged.path), true);
  assert.equal(isComposerAttachmentPath("src/aldunis-code-composer-images/template.ts"), false);
  const packageResult = await assembleContextPackage(root, [{ path: staged.path, kind: "file" }]);
  assert.deepEqual(
    packageResult.attachments.map(({ path, kind }) => ({ path, kind })),
    [{ path: staged.path, kind: "image" }],
  );
  // Staged images are gitignored so accidental `git add -A` cannot commit them.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const status = await execFileAsync(
    "git",
    ["-C", root, "status", "--porcelain", "--", staged.path],
    { encoding: "utf8" },
  );
  assert.equal(status.stdout.trim(), "");
  const browse = await browseRepositoryFiles(root, "shot");
  assert.equal(
    browse.files.some((file) => file.path === staged.path),
    false,
  );
  await assert.rejects(
    () =>
      stageComposerImage(root, {
        mediaType: "application/pdf",
        data: Buffer.from("%PDF").toString("base64"),
      }),
    /GIF, JPEG, PNG, and WebP/,
  );
  await assert.rejects(
    () =>
      stageComposerImage(root, {
        mediaType: "image/png",
        data: Buffer.from("not-a-png").toString("base64"),
      }),
    /does not match the declared image type/,
  );
  await assert.rejects(
    () =>
      stageComposerImage(root, {
        mediaType: "image/png",
        data: Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64"),
      }),
    /at most 2 MB/,
  );
});

test("stageComposerImage rejects an oversized managed ignore file before reading it", async () => {
  const { root } = await fixture();
  const staging = join(root, COMPOSER_ATTACHMENT_DIR);
  await mkdir(staging);
  await writeFile(
    join(staging, ".gitignore"),
    `${"*".repeat(MAX_COMPOSER_ATTACHMENT_IGNORE_BYTES + 1)}\n`,
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.rejects(
    () =>
      stageComposerImage(root, {
        mediaType: "image/png",
        data: png.toString("base64"),
        name: "ignored.png",
      }),
    /gitignore exceeds the supported size/,
  );
  assert.deepEqual(await readdir(staging), [".gitignore"]);
});

test("stageComposerImage bounds staging-tree inspection before writing", async () => {
  const { root } = await fixture();
  const staging = join(root, COMPOSER_ATTACHMENT_DIR);
  await mkdir(staging);
  await writeFile(join(staging, ".gitignore"), "*\n");
  await Promise.all(
    Array.from({ length: MAX_INSPECTED_COMPOSER_ATTACHMENT_ENTRIES }, (_, index) =>
      mkdir(join(staging, index.toString(16).padStart(8, "0"))),
    ),
  );
  const before = await readdir(staging);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.rejects(
    () =>
      stageComposerImage(root, {
        mediaType: "image/png",
        data: png.toString("base64"),
        name: "bounded.png",
        conversationId: "shared",
      }),
    /too many entries to inspect/,
  );
  assert.deepEqual(await readdir(staging), before);
});

test("stageComposerImage retains the existing image quota within the inspection bound", async () => {
  const { root } = await fixture();
  const staging = join(root, COMPOSER_ATTACHMENT_DIR);
  await mkdir(staging);
  await writeFile(join(staging, ".gitignore"), "*\n");
  await Promise.all(
    Array.from({ length: 31 }, async (_, index) => {
      const scope = join(staging, index.toString(16).padStart(8, "0"));
      await mkdir(scope);
      await writeFile(join(scope, `image-${index.toString(16).padStart(8, "0")}.png`), "image");
    }),
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.doesNotReject(() =>
    stageComposerImage(root, {
      mediaType: "image/png",
      data: png.toString("base64"),
      name: "last.png",
      conversationId: "shared",
    }),
  );
  await assert.rejects(
    () =>
      stageComposerImage(root, {
        mediaType: "image/png",
        data: png.toString("base64"),
        name: "overflow.png",
        conversationId: "shared",
      }),
    /staging is full/,
  );
});

test("stageComposerImage serializes the final quota slot across processes", async () => {
  const { root } = await fixture();
  const staging = join(root, COMPOSER_ATTACHMENT_DIR);
  await mkdir(staging);
  await writeFile(join(staging, ".gitignore"), "*\n");
  await Promise.all(
    Array.from({ length: 31 }, async (_, index) => {
      const scope = join(staging, index.toString(16).padStart(8, "0"));
      await mkdir(scope);
      await writeFile(join(scope, `image-${index.toString(16).padStart(8, "0")}.png`), "image");
    }),
  );
  const childSource = `
    import { stageComposerImage } from ${JSON.stringify(new URL("./context.ts", import.meta.url).href)};
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await stageComposerImage(process.argv[1], {
      mediaType: "image/png",
      data: png.toString("base64"),
      name: process.argv[2] + ".png",
      conversationId: "shared",
    });
  `;
  const stageInProcess = (name: string) =>
    new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childSource, root, name],
        { stdio: "ignore" },
      );
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });

  const exits = await Promise.all([stageInProcess("left"), stageInProcess("right")]);
  assert.deepEqual(exits.toSorted(), [0, 1]);
  let imageCount = 0;
  for (const scope of await readdir(staging, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    imageCount += (await readdir(join(staging, scope.name))).filter((name) =>
      name.endsWith(".png"),
    ).length;
  }
  assert.equal(imageCount, 32);
  assert.equal((await readdir(staging)).includes(".quota.lock"), false);
});

test("stageComposerImage releases the quota lock after a failed transaction", async () => {
  const { root } = await fixture();
  const staging = join(root, COMPOSER_ATTACHMENT_DIR);
  await mkdir(staging);
  await writeFile(join(staging, ".gitignore"), "*\n");
  await writeFile(join(staging, "shared"), "not a directory");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.rejects(
    () =>
      stageComposerImage(root, {
        mediaType: "image/png",
        data: png.toString("base64"),
        conversationId: "shared",
      }),
    /not a directory/,
  );
  assert.equal((await readdir(staging)).includes(".quota.lock"), false);
  await assert.doesNotReject(() =>
    stageComposerImage(root, {
      mediaType: "image/png",
      data: png.toString("base64"),
      conversationId: "11111111-1111-1111-1111-111111111111",
    }),
  );
});

test("resolveWorktreeImagePath pins in-tree images and rejects escapes", async () => {
  const { parent, root } = await fixture();
  const resolved = await resolveWorktreeImagePath(root, join(root, "image.png"));
  assert.equal(resolved?.path, "image.png");
  assert.equal(resolved?.mediaType, "image/png");
  assert.ok((resolved?.size ?? 0) >= 8);
  assert.equal(await resolveWorktreeImagePath(root, join(parent, "outside.png")), null);
  await writeFile(join(parent, "outside.png"), Buffer.from([137, 80, 78, 71]));
  assert.equal(await resolveWorktreeImagePath(root, join(parent, "outside.png")), null);
  assert.equal(await resolveWorktreeImagePath(root, join(root, "src/main.ts")), null);
});

test("resolveWorktreeImagePath rejects an atomic replacement without retaining it", async () => {
  const { root } = await fixture();
  const path = join(root, "image.png");
  const replacement = join(root, "replacement.png");
  await writeFile(replacement, "");
  await truncate(replacement, 128 * 1024 * 1024);

  await assert.rejects(
    () =>
      resolveWorktreeImagePath(root, path, {
        async open(candidate, flags) {
          assert.equal((flags & constants.O_NONBLOCK) !== 0, true);
          assert.equal((flags & constants.O_NOFOLLOW) !== 0, true);
          const handle = await open(candidate, flags);
          await rename(replacement, path);
          return handle;
        },
        lstat,
      }),
    /changed while it was opened/,
  );
});

test("stable worktree image reads reject an ancestor symlink before reading", async () => {
  const { parent, root } = await fixture();
  const directory = join(root, "images");
  const moved = join(root, "images-moved");
  const outside = join(parent, "outside-images");
  const path = join(directory, "image.png");
  await mkdir(directory);
  await mkdir(outside);
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(join(outside, "image.png"), Buffer.alloc(1024));
  let reads = 0;

  await assert.rejects(
    () =>
      readStableWorktreeImage(path, "images/image.png", {
        async open(candidate, flags) {
          await rename(directory, moved);
          await symlink(outside, directory);
          const handle = await open(candidate, flags);
          return {
            stat: handle.stat.bind(handle),
            async read(...args: Parameters<typeof handle.read>) {
              reads += 1;
              return handle.read(...args);
            },
            close: handle.close.bind(handle),
          };
        },
        lstat,
      }),
    /changed while it was opened/,
  );
  assert.equal(reads, 0);
});

test("stageWorktreeImageCopy rejects descriptor oversize before reading", async () => {
  const { root } = await fixture();
  const path = join(root, "image.png");
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let reads = 0;
  let closes = 0;

  await assert.rejects(
    () =>
      stageWorktreeImageCopy(
        root,
        path,
        {},
        {
          async open() {
            return {
              async stat() {
                return { isFile: () => true, size: MAX_IMAGE_BYTES + 1 } as Awaited<
                  ReturnType<import("node:fs/promises").FileHandle["stat"]>
                >;
              },
              async read() {
                reads += 1;
                return { bytesRead: 0, buffer: Buffer.alloc(0) };
              },
              async close() {
                closes += 1;
              },
            };
          },
          lstat,
        },
      ),
    /exceeds the 2 MB image limit/,
  );

  assert.equal(reads, 0);
  assert.equal(closes, 1);
});

test("stageWorktreeImageCopy accepts an exact-limit image", async () => {
  const { root } = await fixture();
  const path = join(root, "exact.png");
  const png = Buffer.alloc(MAX_IMAGE_BYTES);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  await writeFile(path, png);

  const staged = await stageWorktreeImageCopy(root, path);

  assert.equal(staged?.size, MAX_IMAGE_BYTES);
  assert.equal(staged?.mediaType, "image/png");
  assert.match(staged?.path ?? "", /aldunis-code-composer-images\/shared\/exact-/);
});

test("stageWorktreeImageCopy rejects growth beyond admitted descriptor size", async () => {
  const { root } = await fixture();
  const path = join(root, "image.png");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(path, png);
  const admitted = await lstat(path);
  let reads = 0;

  await assert.rejects(
    () =>
      stageWorktreeImageCopy(
        root,
        path,
        {},
        {
          async open() {
            return {
              async stat() {
                return admitted;
              },
              async read(buffer: Buffer, offset: number, length: number) {
                reads += 1;
                if (reads === 1) png.copy(buffer, offset, 0, length);
                return { bytesRead: reads === 1 ? length : 1, buffer };
              },
              async close() {},
            };
          },
          lstat,
        },
      ),
    /changed while it was read/,
  );
});
