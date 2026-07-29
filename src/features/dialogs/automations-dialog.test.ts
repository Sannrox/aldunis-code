import assert from "node:assert/strict";
import test from "node:test";
import {
  automationThreadBaseLabel,
  automationThreadLabels,
  formatAutomationInterval,
  type AutomationThreadOption,
} from "./automations-dialog";

const thread = {
  id: "thread-1",
  title: "Repeated prompt",
  projectName: "aldunis-code",
  provider: "codex-cli",
} satisfies AutomationThreadOption;

test("automation choices include project and provider context", () => {
  assert.equal(
    automationThreadBaseLabel(thread),
    "Repeated prompt · aldunis-code · Codex",
  );
});

test("automation choices label only exact remaining collisions", () => {
  const duplicate = { ...thread, id: "thread-2" };
  const unique = { ...thread, id: "thread-3", title: "Unique prompt" };
  assert.deepEqual([...automationThreadLabels([thread, duplicate, unique])], [
    ["thread-1", "Repeated prompt · aldunis-code · Codex · Task thread-1"],
    ["thread-2", "Repeated prompt · aldunis-code · Codex · Task thread-2"],
    ["thread-3", "Unique prompt · aldunis-code · Codex"],
  ]);
});

test("automation interval summaries use the largest exact readable unit", () => {
  assert.equal(formatAutomationInterval(60), "every 1 minute");
  assert.equal(formatAutomationInterval(5_400), "every 90 minutes");
  assert.equal(formatAutomationInterval(7_200), "every 2 hours");
  assert.equal(formatAutomationInterval(172_800), "every 2 days");
});
