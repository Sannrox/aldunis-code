import assert from "node:assert/strict";
import test from "node:test";
import { stageComposerImages, type ComposerImageStageRequest } from "./composer-image-staging";

function fakeFile(name: string, path?: string): File {
  return {
    name,
    type: "image/png",
    size: 3,
    path,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as File;
}

test("stages in-worktree paths and uploaded images through one interface", async () => {
  const requests: ComposerImageStageRequest[] = [];
  const result = await stageComposerImages({
    files: [fakeFile("existing.png", "/repo/screens/existing.png"), fakeFile("pasted.png")],
    repositoryRoot: "/repo",
    worktreePath: "/repo",
    conversationId: "conversation-1",
    availablePins: 10,
    stageImage: async (request) => {
      requests.push(request);
      return "absolutePath" in request ? "screens/existing.png" : ".aldunis/pasted.png";
    },
  });

  assert.deepEqual(result, {
    paths: ["screens/existing.png", ".aldunis/pasted.png"],
    omitted: 0,
    failure: null,
  });
  assert.deepEqual(requests[0], {
    root: "/repo",
    worktree: "/repo",
    absolutePath: "/repo/screens/existing.png",
  });
  assert.equal("data" in requests[1], true);
});

test("preserves partial success and normalizes a later staging failure", async () => {
  let calls = 0;
  const result = await stageComposerImages({
    files: [fakeFile("one.png"), fakeFile("two.png")],
    repositoryRoot: "/repo",
    worktreePath: "/worktree",
    conversationId: "conversation-1",
    availablePins: 10,
    stageImage: async () => {
      calls += 1;
      if (calls === 2) throw new Error("Host rejected the image.");
      return "one.png";
    },
  });

  assert.deepEqual(result, {
    paths: ["one.png"],
    omitted: 0,
    failure: "Host rejected the image.",
  });
});

test("enforces pin capacity, batch bounds, and duplicate paths", async () => {
  const files = Array.from({ length: 10 }, (_, index) => fakeFile(`${index}.png`));
  const result = await stageComposerImages({
    files,
    repositoryRoot: "/repo",
    worktreePath: "/worktree",
    conversationId: "conversation-1",
    availablePins: 2,
    stageImage: async () => "same.png",
  });

  assert.deepEqual(result, { paths: ["same.png"], omitted: 8, failure: null });
});

test("fails through the interface when workspace or pin capacity is unavailable", async () => {
  const noWorkspace = await stageComposerImages({
    files: [fakeFile("one.png")],
    repositoryRoot: null,
    worktreePath: null,
    conversationId: "conversation-1",
    availablePins: 1,
    stageImage: async () => "unused",
  });
  assert.equal(noWorkspace.failure, "Open a repository and worktree before attaching images.");

  const noCapacity = await stageComposerImages({
    files: [fakeFile("one.png")],
    repositoryRoot: "/repo",
    worktreePath: "/worktree",
    conversationId: "conversation-1",
    availablePins: 0,
    stageImage: async () => "unused",
  });
  assert.equal(noCapacity.failure, "Pin at most 100 file or folder paths.");
});
