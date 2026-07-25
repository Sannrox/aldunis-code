/**
 * Design fixtures from docs/design/workbench-mock.html.
 * Activated only with `?mock=1` (or localStorage aldunis.designMock=1).
 * Not persisted to the server — visual parity for design review only.
 */
import type {
  ChangedFile,
  ConversationSummary,
  DeliveryContext,
  DiffAnnotation,
  FileDiff,
  RepositoryMetadata,
} from "../../types";

export function isDesignMockEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("mock") === "1" || params.get("design") === "1") return true;
  try {
    return window.localStorage.getItem("aldunis.designMock") === "1";
  } catch {
    return false;
  }
}

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

export const DESIGN_MOCK_REPOSITORY: RepositoryMetadata = {
  projectId: "design-mock-project",
  name: "All projects",
  root: "/Users/you/Projects",
  selectedWorktree: "/Users/you/Projects/aldunis-code",
  worktrees: [
    {
      path: "/Users/you/Projects/aldunis-code",
      head: "abc",
      branch: "main",
      state: "available",
      ownership: "user",
      recovery: "available",
      originalPath: null,
    },
    {
      path: "/Users/you/Projects/aldunis-code/.aldunis/wt/feat-acp-kiro",
      head: "abc",
      branch: "feat/acp-kiro",
      state: "available",
      ownership: "aldunis",
      recovery: "available",
      originalPath: null,
    },
    {
      path: "/Users/you/Projects/aldunis-code/.aldunis/wt/chore-fonts",
      head: "abc",
      branch: "chore/self-host-fonts",
      state: "available",
      ownership: "aldunis",
      recovery: "available",
      originalPath: null,
    },
    {
      path: "/Users/you/Projects/tenkai/.aldunis/wt/remote",
      head: "abc",
      branch: "feat/remote-listener",
      state: "available",
      ownership: "aldunis",
      recovery: "available",
      originalPath: null,
    },
  ],
};

function thread(
  partial: Omit<ConversationSummary, "projectId" | "updatedAt"> & {
    updatedAt?: string;
    minutesAgo?: number;
  },
): ConversationSummary {
  return {
    projectId: DESIGN_MOCK_REPOSITORY.projectId,
    updatedAt: partial.updatedAt ?? ago(partial.minutesAgo ?? 10),
    ...partial,
  };
}

/** Active + settled threads matching workbench-mock.html sample list. */
export function designMockConversations(): ConversationSummary[] {
  return [
    thread({
      id: "mock-kiro",
      title: "Wire the Kiro adapter to the shared ACP prompt shape",
      // worktree path ends with branch name so branchFromWorktree matches the mock labels
      worktree: "/Users/you/Projects/aldunis-code/.aldunis/wt/feat/acp-kiro",
      provider: "claude-code",
      projectName: "aldunis-code",
      status: "pending_approval",
      statusSince: ago(4),
      minutesAgo: 4,
      wokeAt: ago(4),
    }),
    thread({
      id: "mock-fonts",
      title: "Self-host the font families",
      worktree: "/Users/you/Projects/aldunis-code/.aldunis/wt/chore/self-host-fonts",
      provider: "codex-cli",
      projectName: "aldunis-code",
      status: "failed",
      statusSince: ago(18),
      minutesAgo: 18,
      wokeAt: ago(18),
    }),
    thread({
      id: "mock-remote",
      title: "Remote workbench listener",
      worktree: "/Users/you/Projects/tenkai/.aldunis/wt/feat/remote-listener",
      provider: "claude-code",
      projectName: "tenkai",
      status: "awaiting_input",
      statusSince: ago(9),
      minutesAgo: 9,
      wokeAt: ago(9),
    }),
    thread({
      id: "mock-annotations",
      title: "Durable diff annotations",
      worktree: "/Users/you/Projects/aldunis-code/.aldunis/wt/feat/diff-annotations",
      provider: "claude-code",
      projectName: "aldunis-code",
      status: "completed",
      statusSince: ago(42),
      minutesAgo: 42,
      model: "sonnet",
    }),
    thread({
      id: "mock-split",
      title: "Split the workbench components",
      worktree: "/Users/you/Projects/sekai-chisei/.aldunis/wt/codex/split-workbench",
      provider: "codex-cli",
      projectName: "sekai-chisei",
      status: "completed",
      statusSince: ago(60),
      minutesAgo: 60,
    }),
    thread({
      id: "mock-tokens",
      title: "Migrate styles onto semantic tokens",
      worktree: "/Users/you/Projects/aldunis-code/.aldunis/wt/codex/design-tokens",
      provider: "adapter:kiro@local",
      projectName: "aldunis-code",
      status: "running",
      statusSince: ago(2),
      minutesAgo: 2,
    }),
    // Settled shelf
    thread({
      id: "mock-settled-1",
      title: "Light theme sidebar readability",
      worktree: "/Users/you/Projects/aldunis-code/.aldunis/wt/light-sidebar",
      provider: "claude-code",
      projectName: "aldunis-code",
      settledAt: ago(120),
      minutesAgo: 120,
    }),
    thread({
      id: "mock-settled-2",
      title: "Extract a CloseButton component",
      worktree: "/Users/you/Projects/aldunis-code/.aldunis/wt/close-button",
      provider: "claude-code",
      projectName: "aldunis-code",
      settledAt: ago(180),
      minutesAgo: 180,
    }),
    thread({
      id: "mock-settled-3",
      title: "System theme follows the OS",
      worktree: "1d",
      provider: "claude-code",
      projectName: "aldunis-code",
      settledAt: ago(60 * 24),
      minutesAgo: 60 * 24,
    }),
  ];
}

export const DESIGN_MOCK_PRIMARY_ID = "mock-annotations";

export const DESIGN_MOCK_THREAD = {
  title: "Durable diff annotations",
  branch: "feat/diff-annotations",
  provider: "claude-code",
  model: "sonnet",
  user: "Add durable local diff annotations that survive a rebase.",
  assistant:
    "Annotations now anchor to content hashes rather than line numbers, so they survive a rebase. Six files changed, tests pass.",
  tools: [
    { label: "Edit", code: "src/annotations.ts", result: "+118", ok: true },
    { label: "Test", code: "npm test", result: "133 passed", ok: true },
  ],
  done: {
    files: "6 files · +212 −34",
    worktree: "feat/diff-annotations",
    meter: "6 of 8",
  },
};

export const DESIGN_MOCK_WORKTREE_LIMIT = 8;
export const DESIGN_MOCK_MANAGED_WORKTREE_COUNT = 6;

/** Review panel file list from workbench-mock.html (6 files · +212 −34). */
export const DESIGN_MOCK_CHANGED_FILES: ChangedFile[] = [
  { path: "src/annotations.ts", previousPath: null, state: "modified", additions: 118, deletions: 0 },
  { path: "src/annotations.test.ts", previousPath: null, state: "modified", additions: 54, deletions: 0 },
  { path: "server/annotations.ts", previousPath: null, state: "modified", additions: 31, deletions: 12 },
  { path: "server/changes.ts", previousPath: null, state: "modified", additions: 9, deletions: 22 },
  { path: "src/main.tsx", previousPath: null, state: "modified", additions: 6, deletions: 0 },
  { path: "docs/architecture.md", previousPath: null, state: "modified", additions: 4, deletions: 0 },
];

export const DESIGN_MOCK_DELIVERY: DeliveryContext = {
  repository: DESIGN_MOCK_REPOSITORY.root,
  worktree: "/Users/you/Projects/aldunis-code/.aldunis/wt/feat/diff-annotations",
  branch: "feat/diff-annotations",
  detached: false,
  upstream: "origin/feat/diff-annotations",
  remotes: [{ name: "origin", url: "git@github.com:you/aldunis-code.git" }],
  staged: [],
  unstaged: DESIGN_MOCK_CHANGED_FILES.map((file) => file.path),
};

export function designMockDiff(path: string): FileDiff {
  const file = DESIGN_MOCK_CHANGED_FILES.find((item) => item.path === path)
    ?? DESIGN_MOCK_CHANGED_FILES[0];
  const isPrimary = path === "src/annotations.ts";
  return {
    ...file,
    identity: `design-mock:${file.path}`,
    message: null,
    patch: isPrimary
      ? "@@ -40,6 +40,18 @@ resolveAnchor\n export function resolveAnchor(\n   note: Annotation,\n-  return file.lines[note.line];\n+  const hash = hashRegion(file, note.region);\n+  return findByHash(file, hash) ?? note.fallbackLine;\n }"
      : null,
    lines: isPrimary
      ? [
          { index: 0, side: "context", oldLine: 40, newLine: 40, content: "export function resolveAnchor(" },
          { index: 1, side: "context", oldLine: 41, newLine: 41, content: "  note: Annotation," },
          { index: 2, side: "deletion", oldLine: 42, newLine: null, content: "  return file.lines[note.line];" },
          { index: 3, side: "addition", oldLine: null, newLine: 42, content: "  const hash = hashRegion(file, note.region);" },
          { index: 4, side: "addition", oldLine: null, newLine: 43, content: "  return findByHash(file, hash) ?? note.fallbackLine;" },
          { index: 5, side: "context", oldLine: 43, newLine: 44, content: "}" },
        ]
      : [
          {
            index: 0,
            side: "metadata",
            oldLine: null,
            newLine: null,
            content: `Design fixture · ${file.additions ?? 0} additions, ${file.deletions ?? 0} deletions`,
          },
        ],
  };
}

export function designMockAnnotations(threadId: string): DiffAnnotation[] {
  return [
    {
      id: "mock-ann-1",
      threadId,
      checkpointId: null,
      diffIdentity: "design-mock:src/annotations.ts",
      path: "src/annotations.ts",
      previousPath: null,
      targetState: "modified",
      scope: "line",
      side: "addition",
      oldLine: null,
      newLine: 43,
      text: "What happens when the region is deleted outright?",
      capturedContext: "return findByHash(file, hash) ?? note.fallbackLine;",
      resolution: "unresolved",
      stale: false,
      staleReason: null,
    },
  ];
}

export function isDesignMockThread(threadId: string | null | undefined): boolean {
  return Boolean(threadId?.startsWith("mock-"));
}

export function isDesignMockRepository(repository: RepositoryMetadata | null | undefined): boolean {
  return repository?.projectId === DESIGN_MOCK_REPOSITORY.projectId;
}
