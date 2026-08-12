import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ShikigamiAdapter } from "./shikigami-provider.ts";

async function assertProcessStops(pid: number, detail: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
  }
  process.kill(pid, "SIGKILL");
  assert.fail(detail);
}

test("Shikigami readiness cancellation terminates its native version child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-readiness-cancel-"));
  const executable = join(directory, "fake-shikigami");
  const pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const pending = new ShikigamiAdapter(executable).readiness(process.env, {
    signal: controller.signal,
  });
  while (!(await readFile(pidPath, "utf8").catch(() => ""))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  await assertProcessStops(
    Number(await readFile(pidPath, "utf8")),
    "cancelled Shikigami readiness child remained active",
  );
});

test("Shikigami readiness cancellation terminates its native model-catalog child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-catalog-cancel-"));
  const executable = join(directory, "fake-shikigami");
  const pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === "version") {
  console.log("shikigami 1.0.5");
  process.exit(0);
}
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const pending = new ShikigamiAdapter(executable).readiness(
    { ...process.env, SHIKIGAMI_MODEL_ADAPTER: "plane" },
    { cwd: directory, signal: controller.signal },
  );
  while (!(await readFile(pidPath, "utf8").catch(() => ""))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  await assertProcessStops(
    Number(await readFile(pidPath, "utf8")),
    "cancelled Shikigami model-catalog child remained active",
  );
});
