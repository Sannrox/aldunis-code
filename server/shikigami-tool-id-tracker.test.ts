import assert from "node:assert/strict";
import test from "node:test";
import { ProviderProtocolError } from "./provider.ts";
import {
  MAX_OPEN_SHIKIGAMI_TOOL_CORRELATIONS,
  ShikigamiToolIdTracker,
} from "./shikigami-provider.ts";

test("Shikigami tool correlation retention is bounded and recovers after an end", () => {
  const tools = new ShikigamiToolIdTracker();
  const ids = Array.from({ length: MAX_OPEN_SHIKIGAMI_TOOL_CORRELATIONS }, (_, index) =>
    tools.start(index % 2 === 0 ? "read_file" : "write_file"),
  );

  assert.throws(
    () => tools.start("overflow"),
    (error: unknown) =>
      error instanceof ProviderProtocolError &&
      /too many unmatched tool start/i.test(error.message),
  );
  assert.equal(tools.end("read_file"), ids.at(-2));
  assert.match(tools.start("recovered"), /^shikigami:recovered:/);
});
