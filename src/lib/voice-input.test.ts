import assert from "node:assert/strict";
import test from "node:test";
import {
  appendVoiceTranscript,
  collectVoiceTranscript,
  composeVoiceDraft,
  createVoiceInputModule,
  getVoiceRecognitionConstructor,
  initialVoiceInputSnapshot,
  matchesVoiceInputShortcut,
  voiceInputErrorMessage,
  type VoiceRecognition,
  type VoiceInputSnapshot,
  type VoiceRecognitionErrorEvent,
  type VoiceRecognitionResultEvent,
  type VoiceRecognitionResultList,
} from "./voice-input";

class FakeRecognition implements VoiceRecognition {
  static latest: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: VoiceRecognitionResultEvent) => void) | null = null;
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  constructor() {
    FakeRecognition.latest = this;
  }
  start() {
    this.startCalls += 1;
  }
  stop() {
    this.stopCalls += 1;
  }
  abort() {
    this.abortCalls += 1;
  }
}

test("voice recognition prefers the standard constructor and supports the WebKit fallback", () => {
  assert.equal(
    getVoiceRecognitionConstructor({
      SpeechRecognition: FakeRecognition,
      webkitSpeechRecognition: class extends FakeRecognition {},
    }),
    FakeRecognition,
  );
  const webkit = class extends FakeRecognition {};
  assert.equal(getVoiceRecognitionConstructor({ webkitSpeechRecognition: webkit }), webkit);
  assert.equal(getVoiceRecognitionConstructor({}), null);
});

test("voice input shortcut works with either platform modifier and ignores collisions", () => {
  assert.equal(
    matchesVoiceInputShortcut({
      key: "m",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }),
    true,
  );
  assert.equal(
    matchesVoiceInputShortcut({
      key: "M",
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    }),
    true,
  );
  assert.equal(
    matchesVoiceInputShortcut({
      key: "m",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
    false,
  );
  assert.equal(
    matchesVoiceInputShortcut({
      key: "m",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
    }),
    false,
  );
  assert.equal(
    matchesVoiceInputShortcut({
      key: "m",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      repeat: true,
    }),
    false,
  );
  assert.equal(
    matchesVoiceInputShortcut({
      key: "v",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }),
    false,
  );
});

test("voice transcript collection separates changed final and interim results", () => {
  const results = [
    { isFinal: true, length: 1, 0: { transcript: "already committed" } },
    { isFinal: true, length: 1, 0: { transcript: "open the file" } },
    { isFinal: false, length: 1, 0: { transcript: "near the" } },
  ] as unknown as VoiceRecognitionResultList;
  assert.deepEqual(collectVoiceTranscript(results, 1), {
    finalTranscript: "open the file",
    interimTranscript: "near the",
  });
});

test("voice transcript text appends to the current draft without losing spacing", () => {
  assert.equal(appendVoiceTranscript("Fix the", "button"), "Fix the button");
  assert.equal(appendVoiceTranscript("", "  hello  "), "hello");
  assert.equal(
    composeVoiceDraft("Fix the button ", "color", "please"),
    "Fix the button color please",
  );
  assert.equal(composeVoiceDraft("Fix the button ", "", ""), "Fix the button");
});

test("voice errors explain the common permission and device failures", () => {
  assert.match(voiceInputErrorMessage("not-allowed"), /Microphone access was blocked/);
  assert.match(voiceInputErrorMessage("audio-capture"), /No microphone was found/);
  assert.match(voiceInputErrorMessage("unknown"), /could not start/);
});

test("voice input module owns recognition configuration and transcript-to-draft updates", () => {
  const snapshots: VoiceInputSnapshot[] = [];
  const drafts: string[] = [];
  const module = createVoiceInputModule({
    getConstructor: () => FakeRecognition,
    getLanguage: () => "de-DE",
    onDraftChange: (draft) => drafts.push(draft),
    onSnapshotChange: (snapshot) => snapshots.push(snapshot),
  });

  module.start("Review this");
  const recognition = FakeRecognition.latest!;
  assert.equal(recognition.startCalls, 1);
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.lang, "de-DE");
  assert.equal(recognition.maxAlternatives, 1);
  assert.equal(snapshots.at(-1)?.state, "listening");

  recognition.onresult?.({
    resultIndex: 0,
    results: [
      { isFinal: true, length: 1, 0: { transcript: "carefully" } },
      { isFinal: false, length: 1, 0: { transcript: "please" } },
    ] as unknown as VoiceRecognitionResultList,
  });
  assert.equal(drafts.at(-1), "Review this carefully please");
  assert.equal(snapshots.at(-1)?.interimTranscript, "please");

  recognition.onresult?.({
    resultIndex: 0,
    results: [
      { isFinal: true, length: 1, 0: { transcript: "please" } },
    ] as unknown as VoiceRecognitionResultList,
  });
  assert.equal(drafts.at(-1), "Review this carefully please");
});

test("voice input module stops and ignores stale recognition callbacks", () => {
  const snapshots: VoiceInputSnapshot[] = [];
  const drafts: string[] = [];
  const module = createVoiceInputModule({
    getConstructor: () => FakeRecognition,
    onDraftChange: (draft) => drafts.push(draft),
    onSnapshotChange: (snapshot) => snapshots.push(snapshot),
  });

  module.start("");
  const staleRecognition = FakeRecognition.latest!;
  module.stop();
  assert.equal(staleRecognition.stopCalls, 1);
  assert.equal(snapshots.at(-1)?.state, "idle");
  staleRecognition.onresult?.({
    resultIndex: 0,
    results: [
      { isFinal: true, length: 1, 0: { transcript: "stale" } },
    ] as unknown as VoiceRecognitionResultList,
  });
  staleRecognition.onerror?.({ error: "network" });
  staleRecognition.onend?.();
  assert.deepEqual(drafts, []);
  assert.equal(snapshots.at(-1)?.state, "idle");

  module.toggle("next");
  const activeRecognition = FakeRecognition.latest!;
  module.reset();
  assert.equal(activeRecognition.abortCalls, 1);
  assert.equal(snapshots.at(-1)?.state, "idle");
});

test("voice input module normalizes unsupported, error, and disposal behavior", () => {
  const unsupportedSnapshots: VoiceInputSnapshot[] = [];
  const unsupported = createVoiceInputModule({
    getConstructor: () => null,
    onDraftChange: () => assert.fail("unsupported recognition must not update the draft"),
    onSnapshotChange: (snapshot) => unsupportedSnapshots.push(snapshot),
  });
  assert.equal(initialVoiceInputSnapshot(() => null).state, "unsupported");
  unsupported.start("");
  assert.equal(unsupportedSnapshots.at(-1)?.state, "unsupported");
  assert.match(unsupportedSnapshots.at(-1)?.error ?? "", /not available/);

  class ThrowingRecognition extends FakeRecognition {
    start() {
      throw new Error("denied");
    }
  }
  const failureSnapshots: VoiceInputSnapshot[] = [];
  const failed = createVoiceInputModule({
    getConstructor: () => ThrowingRecognition,
    onDraftChange: () => undefined,
    onSnapshotChange: (snapshot) => failureSnapshots.push(snapshot),
  });
  failed.start("");
  assert.equal(failureSnapshots.at(-1)?.state, "error");
  assert.match(failureSnapshots.at(-1)?.error ?? "", /could not start/);

  const disposalSnapshots: VoiceInputSnapshot[] = [];
  const disposable = createVoiceInputModule({
    getConstructor: () => FakeRecognition,
    onDraftChange: () => undefined,
    onSnapshotChange: (snapshot) => disposalSnapshots.push(snapshot),
  });
  disposable.start("");
  const recognition = FakeRecognition.latest!;
  const beforeDispose = disposalSnapshots.length;
  disposable.dispose();
  assert.equal(recognition.abortCalls, 1);
  recognition.onerror?.({ error: "network" });
  recognition.onend?.();
  assert.equal(disposalSnapshots.length, beforeDispose);
  disposable.start("");
  assert.equal(FakeRecognition.latest, recognition);
  disposable.activate();
  disposable.start("");
  assert.notEqual(FakeRecognition.latest, recognition);
});
