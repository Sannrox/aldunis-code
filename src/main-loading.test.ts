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

test("workspace panels stay behind conversation intent", () => {
  const paths = [
    "../changes/changes-panel",
    "../files/file-browser-panel",
    "../preview/preview-panel",
  ];
  for (const path of paths) {
    assert.doesNotMatch(
      conversationSource,
      new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`),
    );
    assert.match(conversationSource, new RegExp(`import\\(["']${path}["']\\)`));
  }
  assert.match(conversationSource, /label="Preview" onDismiss=\{dismissPreview\}/);
  assert.match(
    conversationSource,
    /activePanel === "preview" \|\| previewFloating \|\| agentBrowserViewOpen/,
  );
  assert.doesNotMatch(conversationSource, /previewMounted\s*\|\|/);
  assert.match(conversationSource, /label="Files"/);
  assert.match(conversationSource, /label="Changes"/);
  assert.match(conversationSource, /\{activePanel === "files" && repository && \(/);
  assert.match(conversationSource, /\{activePanel === "changes" && repository && \(/);
});

test("conversation lifecycle dialogs stay behind renderer intent", () => {
  const workbenchPaths = [
    "../dialogs/delete-conversation-dialog",
    "../dialogs/release-worktree-dialog",
    "../dialogs/rename-conversation-dialog",
    "../dialogs/start-delegated-conversation-dialog",
  ];
  for (const path of workbenchPaths) {
    assert.doesNotMatch(
      workbenchSource,
      new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`),
    );
    assert.match(workbenchSource, new RegExp(`import\\(["']${path}["']\\)`));
  }
  const conversationPaths = [
    "../dialogs/conversation-workspace-dialog",
    "../dialogs/release-worktree-dialog",
  ];
  for (const path of conversationPaths) {
    assert.doesNotMatch(
      conversationSource,
      new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`),
    );
    assert.match(conversationSource, new RegExp(`import\\(["']${path}["']\\)`));
  }
  assert.match(workbenchSource, /label="Rename conversation"\s+onDismiss=\{closeRenameDialog\}/);
  assert.match(workbenchSource, /label="Delete conversation"\s+onDismiss=\{closeDeleteDialog\}/);
  assert.match(workbenchSource, /label="Release worktree"\s+onDismiss=\{closeReleaseDialog\}/);
  assert.match(conversationSource, /label="Conversation workspace"/);
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
