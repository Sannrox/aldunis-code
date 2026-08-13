import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./main.tsx", import.meta.url)), "utf8");
const conversationSource = readFileSync(
  fileURLToPath(new URL("./features/code/conversation.tsx", import.meta.url)),
  "utf8",
);
const workbenchSource = readFileSync(
  fileURLToPath(new URL("./features/code/workbench.tsx", import.meta.url)),
  "utf8",
);

test("optional control dialogs stay behind renderer intent boundaries", () => {
  const paths = [
    "./features/dialogs/activity-dialog",
    "./features/dialogs/automations-dialog",
    "./features/dialogs/autonomy-dialog",
    "./features/dialogs/command-palette",
    "./features/dialogs/connections-dialog",
    "./features/dialogs/preferences-dialog",
    "./features/dialogs/provider-management-dialog",
    "./features/dialogs/repository-dialog",
    "./features/dialogs/thread-search-dialog",
    "./features/dialogs/worktree-dialog",
  ];
  for (const path of paths) {
    assert.doesNotMatch(source, new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`));
    assert.match(source, new RegExp(`import\\(["']${path}["']\\)`));
  }
  assert.match(source, /<OptionalControlBoundary/);
  assert.match(source, /\{repositoryDialog && \(/);
  assert.match(source, /\{worktreeDialog && \(/);
  assert.match(source, /\{providerManagement != null && !hostCapabilities\.managed && \(/);
  assert.match(source, /\{searchOpen && \(/);
  assert.match(source, /\{paletteOpen && \(/);
});

test("fork controls stay behind conversation intent", () => {
  const path = "../dialogs/fork-conversation-dialog";
  assert.doesNotMatch(
    conversationSource,
    new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`),
  );
  assert.match(conversationSource, new RegExp(`import\\(["']${path}["']\\)`));
  assert.match(conversationSource, /\{forkOpen && threadId && !managedMode && repository && \(/);
  assert.match(conversationSource, /<OptionalControlBoundary/);
});

test("cross-product screens stay behind non-Code selection intent", () => {
  const path = "../shell/domain-page";
  assert.doesNotMatch(
    workbenchSource,
    new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`),
  );
  assert.match(workbenchSource, new RegExp(`import\\(["']${path}["']\\)`));
  assert.match(workbenchSource, /product !== "code" \? \(/);
  assert.match(workbenchSource, /onDismiss=\{\(\) => onProductChange\("code"\)\}/);
  assert.match(workbenchSource, /<OptionalControlBoundary/);
});

test("the usage dashboard stays behind sidebar intent", () => {
  const path = "./usage-page";
  assert.doesNotMatch(
    workbenchSource,
    new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`),
  );
  assert.match(workbenchSource, new RegExp(`import\\(["']${path}["']\\)`));
  assert.match(workbenchSource, /const \[usageOpen, setUsageOpen\] = useState\(false\)/);
  assert.match(workbenchSource, /usageOpen \? \(/);
  assert.match(workbenchSource, /label="Usage" onDismiss=\{\(\) => setUsageOpen\(false\)\}/);
});
