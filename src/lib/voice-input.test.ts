import assert from "node:assert/strict";
import test from "node:test";
import {
  appendVoiceTranscript,
  collectVoiceTranscript,
  composeVoiceDraft,
  getVoiceRecognitionConstructor,
  voiceInputErrorMessage,
  type VoiceRecognition,
  type VoiceRecognitionResultList,
} from "./voice-input";

class FakeRecognition implements VoiceRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart = null;
  onresult = null;
  onerror = null;
  onend = null;
  start() {}
  stop() {}
}

test("voice recognition prefers the standard constructor and supports the WebKit fallback", () => {
  assert.equal(
    getVoiceRecognitionConstructor({ SpeechRecognition: FakeRecognition, webkitSpeechRecognition: class extends FakeRecognition {} }),
    FakeRecognition,
  );
  const webkit = class extends FakeRecognition {};
  assert.equal(getVoiceRecognitionConstructor({ webkitSpeechRecognition: webkit }), webkit);
  assert.equal(getVoiceRecognitionConstructor({}), null);
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
  assert.equal(composeVoiceDraft("Fix the button ", "color", "please"), "Fix the button color please");
  assert.equal(composeVoiceDraft("Fix the button ", "", ""), "Fix the button");
});

test("voice errors explain the common permission and device failures", () => {
  assert.match(voiceInputErrorMessage("not-allowed"), /Microphone access was blocked/);
  assert.match(voiceInputErrorMessage("audio-capture"), /No microphone was found/);
  assert.match(voiceInputErrorMessage("unknown"), /could not start/);
});
