import assert from "node:assert/strict";
import test from "node:test";
import { appendProviderEvent, readyComposerPlaceholder } from "./conversation";
import type { ProviderEvent } from "../../types";

test("ready composer copy distinguishes new work from an existing conversation", () => {
  assert.equal(
    readyComposerPlaceholder("Codex CLI", null),
    "Describe what you want to work on…",
  );
  assert.equal(
    readyComposerPlaceholder("Codex CLI", "thread-1"),
    "Reply to Codex CLI…",
  );
});

test("provider browser observations replace the prior transient frame", () => {
  const first = {
    kind: "browser_observation",
    provider: "codex-cli",
    observationId: "frame-1",
    imageData: "data:image/jpeg;base64,AA==",
    mediaType: "image/jpeg",
  } satisfies ProviderEvent;
  const second = { ...first, observationId: "frame-2", imageData: "data:image/jpeg;base64,Ag==" } satisfies ProviderEvent;
  const next = appendProviderEvent([
    { kind: "assistant_text", text: "before" },
    first,
    { kind: "assistant_text", text: "after" },
  ], second);
  assert.deepEqual(next, [
    { kind: "assistant_text", text: "before" },
    second,
    { kind: "assistant_text", text: "after" },
  ]);
});
