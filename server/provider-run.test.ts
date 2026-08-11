import assert from "node:assert/strict";
import test from "node:test";
import {
  admitProviderRun,
  createProviderRunSink,
  handleProviderRun,
  shouldReleaseBrowserProviderToken,
  type ProviderRunModuleContext,
  type ProviderRunOutput,
} from "./provider-run.ts";
import { RepositoryError } from "./repository.ts";

const output = {} as ProviderRunOutput;

test("browser provider token release follows accepted Codex session ownership", () => {
  assert.equal(shouldReleaseBrowserProviderToken("codex-cli", false), true);
  assert.equal(shouldReleaseBrowserProviderToken("codex-cli", true), false);
  assert.equal(shouldReleaseBrowserProviderToken("claude-code", false), true);
});

function moduleContext(
  overrides: Partial<ProviderRunModuleContext> = {},
): ProviderRunModuleContext {
  return {
    internalRequest: false,
    remoteRequest: false,
    activeCheckpointProjects: new Set(),
    activeCheckpointWorktrees: new Set(),
    checkpointWorktreeKey: (projectId, worktree) => JSON.stringify([projectId, worktree]),
    selectedWorktree: async (root, worktree) => ({ root, worktree }),
    ...overrides,
  } as ProviderRunModuleContext;
}

test("run admission rejects incomplete input before touching provider dependencies", async () => {
  await assert.rejects(
    handleProviderRun(
      { body: { root: "/repo", worktree: "/repo", prompt: "Inspect" } },
      output,
      moduleContext({
        selectedWorktree: async () => {
          throw new Error("workspace selection must not run");
        },
      }),
    ),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 400 &&
      error.message.includes("interaction mode, provider, and model"),
  );
});

test("typed admission reports the same rejection to acceptance and completion callers", async () => {
  const execution = admitProviderRun(
    { body: { root: "/repo", worktree: "/repo", prompt: "Inspect" } },
    createProviderRunSink(),
    moduleContext(),
  );

  await assert.rejects(
    execution.accepted,
    (error: unknown) => error instanceof RepositoryError && error.status === 400,
  );
  await assert.rejects(
    execution.completed,
    (error: unknown) => error instanceof RepositoryError && error.status === 400,
  );
});

test("run admission rejects automation authority from external requests", async () => {
  await assert.rejects(
    handleProviderRun(
      {
        body: {
          root: "/repo",
          worktree: "/repo",
          prompt: "Inspect",
          conversationId: "conversation-1",
          mode: "ask",
          provider: "codex-cli",
          model: "gpt-5.6",
          automationFireId: "48cb0790-05b2-4b20-9baf-9d05e6852e92",
        },
      },
      output,
      moduleContext(),
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 400,
  );
});

test("remote run admission rejects folder context before filesystem assembly", async () => {
  let selected = false;
  await assert.rejects(
    handleProviderRun(
      {
        body: {
          root: "/repo",
          worktree: "/repo",
          prompt: "Inspect",
          conversationId: "conversation-1",
          mode: "ask",
          provider: "codex-cli",
          model: "gpt-5.6",
          contextPins: [{ path: "src", kind: "folder" }],
        },
      },
      output,
      moduleContext({
        remoteRequest: true,
        selectedWorktree: async (root, worktree) => {
          selected = true;
          return { root, worktree };
        },
      }),
    ),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 403 &&
      error.message.includes("Remote folder pinning"),
  );
  assert.equal(selected, true);
});
