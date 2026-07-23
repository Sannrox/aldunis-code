import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  composePrompt,
  MAX_CONTEXT_FILES,
  resolveContextAttachments,
  searchRepositoryFiles,
} from "./context.ts";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "aldunis-context-"));
  const root = join(parent, "repository");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export const ready = true;\n");
  await writeFile(join(root, ".env"), "TOKEN=secret\n");
  await writeFile(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
  await writeFile(join(root, "image.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(root, "oversized.txt"), "x".repeat(64 * 1024 + 1));
  await import("node:child_process").then(({ execFile }) => new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "-q", root], (error) => error ? reject(error) : resolve());
  }));
  return { parent, root };
}

test("file discovery is repository-scoped and hides secret-like names", async () => {
  const { root } = await fixture();
  assert.deepEqual(await searchRepositoryFiles(root, "main"), ["src/main.ts"]);
  assert.equal((await searchRepositoryFiles(root, "")).includes(".env"), false);
});

test("text and supported images resolve into bounded local context", async () => {
  const { root } = await fixture();
  const attachments = await resolveContextAttachments(root, ["src/main.ts", "image.png"]);
  assert.deepEqual(attachments.map(({ path, kind }) => ({ path, kind })), [
    { path: "src/main.ts", kind: "text" },
    { path: "image.png", kind: "image" },
  ]);
  const prompt = composePrompt("Review this.", attachments);
  assert.match(prompt, /export const ready/);
  assert.match(prompt, /<image path="image.png"/);
});

test("visible element references compose as bounded escaped structured context", () => {
  const prompt = composePrompt("Explain this.", [], [{
    selector: "main > button:nth-of-type(1)",
    tag: "button",
    role: "button",
    name: `Save "draft"`,
    text: "<untrusted> page text",
  }]);
  assert.match(prompt, /<visible-element/);
  assert.match(prompt, /Save &quot;draft&quot;/);
  assert.match(prompt, /&lt;untrusted&gt; page text/);
  assert.doesNotMatch(prompt, /<untrusted>/);
});

test("missing, binary, oversized, secret-like, excessive, and escaping inputs fail explicitly", async () => {
  const { parent, root } = await fixture();
  await assert.rejects(() => resolveContextAttachments(root, ["missing.ts"]), /missing or was deleted/);
  await assert.rejects(() => resolveContextAttachments(root, ["binary.dat"]), /binary/);
  await assert.rejects(() => resolveContextAttachments(root, ["oversized.txt"]), /exceeds/);
  await assert.rejects(() => resolveContextAttachments(root, [".env"]), /secret-like/);
  await assert.rejects(
    () => resolveContextAttachments(root, Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, index) => `${index}.ts`)),
    /Attach at most/,
  );
  await writeFile(join(parent, "outside.txt"), "outside");
  await symlink(join(parent, "outside.txt"), join(root, "linked.txt"));
  await assert.rejects(() => resolveContextAttachments(root, ["linked.txt"]), /escapes/);
});
