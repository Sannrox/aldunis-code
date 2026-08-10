import assert from "node:assert/strict";
import test from "node:test";
import { electronMcpEnvironment, withElectronRunAsNode } from "./electron-runtime.ts";

test("Electron MCP helpers get ELECTRON_RUN_AS_NODE so process.execPath does not open a second dock icon", () => {
  const electron = electronMcpEnvironment(
    { ALDUNIS_BROWSER_TOKEN: "token" },
    "43.2.0",
  );
  assert.equal(electron.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(electron.ALDUNIS_BROWSER_TOKEN, "token");

  const node = electronMcpEnvironment({ ALDUNIS_BROWSER_TOKEN: "token" }, undefined);
  assert.equal(node.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(node.ALDUNIS_BROWSER_TOKEN, "token");
});

test("withElectronRunAsNode leaves non-Electron process environments untouched", () => {
  const source = { PATH: "/bin", ELECTRON_RUN_AS_NODE: "unexpected" };
  const electron = withElectronRunAsNode(source, "43.2.0");
  const node = withElectronRunAsNode(source, undefined);
  assert.equal(electron.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(node.ELECTRON_RUN_AS_NODE, "unexpected");
  assert.deepEqual(source, { PATH: "/bin", ELECTRON_RUN_AS_NODE: "unexpected" });
});
