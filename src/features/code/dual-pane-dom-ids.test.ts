import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Dual-pane workbench mounts two Conversation instances in one document.
 * Hardcoded DOM ids collide across panes and break aria-controls / htmlFor.
 */
const conversationSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "conversation.tsx"),
  "utf8",
);

test("conversation scopes tool activity and composer menu ids by pane", () => {
  const required = [
    /groupId=\{`\$\{pane\}-\$\{keyPrefix\}-tools-\$\{blockIndex\}`\}/,
    /id=\{`\$\{pane\}-new-chat-project-menu`\}/,
    /id=\{`\$\{pane\}-new-chat-workspace-menu`\}/,
    /id=\{`\$\{pane\}-composer-mode-menu`\}/,
    /id=\{`\$\{pane\}-composer-workspace-menu`\}/,
    /id=\{`\$\{pane\}-composer-claude-profile`\}/,
    /id=\{`\$\{pane\}-composer-shikigami-profile`\}/,
  ];
  for (const pattern of required) {
    assert.match(conversationSource, pattern, `missing pane-scoped id: ${pattern}`);
  }

  const banned = [
    /id="new-chat-project-menu"/,
    /id="new-chat-workspace-menu"/,
    /id="composer-mode-menu"/,
    /id="composer-workspace-menu"/,
    /id="composer-claude-profile"/,
    /id="composer-shikigami-profile"/,
    /groupId=\{`\$\{keyPrefix\}-tools-\$\{blockIndex\}`\}/,
  ];
  for (const pattern of banned) {
    assert.doesNotMatch(conversationSource, pattern, `unscoped dual-pane id: ${pattern}`);
  }
});

test("collapsed disclosure controls omit aria-controls until the target is mounted", () => {
  // Conditional panels are not in the DOM when closed; pointing aria-controls at a
  // missing id fails accessibility audits and confuses assistive tech.
  assert.match(
    conversationSource,
    /aria-controls=\{\s*workspaceSetupVisible \? `\$\{pane\}-new-chat-context-body` : undefined\s*\}/,
  );
  assert.match(
    conversationSource,
    /aria-controls=\{\s*planOpen && planPanelMode === "plan" \? `\$\{pane\}-provider-plan-panel` : undefined\s*\}/,
  );
  assert.match(
    conversationSource,
    /aria-controls=\{\s*planOpen && planPanelMode === "graph" \? `\$\{pane\}-provider-plan-panel` : undefined\s*\}/,
  );
  assert.doesNotMatch(conversationSource, /aria-controls=\{`\$\{pane\}-new-chat-context-body`\}/);
});
