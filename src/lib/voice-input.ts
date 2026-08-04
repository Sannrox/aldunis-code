/**
 * Small, browser-only speech recognition boundary for the conversation
 * composer. Audio never enters the Aldunis host; the browser owns the
 * recognition implementation and returns transcript text to the UI.
 */

export interface VoiceRecognitionAlternative {
  transcript: string;
}

export interface VoiceRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: VoiceRecognitionAlternative;
}

export interface VoiceRecognitionResultList {
  length: number;
  [index: number]: VoiceRecognitionResult;
}

export interface VoiceRecognitionResultEvent {
  resultIndex: number;
  results: VoiceRecognitionResultList;
}

export interface VoiceRecognitionErrorEvent {
  error: string;
}

export interface VoiceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: VoiceRecognitionResultEvent) => void) | null;
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

export type VoiceRecognitionConstructor = new () => VoiceRecognition;

export interface VoiceRecognitionScope {
  SpeechRecognition?: VoiceRecognitionConstructor;
  webkitSpeechRecognition?: VoiceRecognitionConstructor;
}

export const VOICE_INPUT_SHORTCUT = "mod+shift+m" as const;
export const VOICE_INPUT_SHORTCUT_LABEL = "⌘⇧M / Ctrl+Shift+M";

export interface VoiceInputShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

export function matchesVoiceInputShortcut(event: VoiceInputShortcutEvent): boolean {
  return (event.metaKey || event.ctrlKey)
    && event.shiftKey
    && !event.altKey
    && event.repeat !== true
    && event.key.toLocaleLowerCase() === "m";
}

export function getVoiceRecognitionConstructor(
  scope: VoiceRecognitionScope | undefined = typeof window === "undefined"
    ? undefined
    : window as unknown as VoiceRecognitionScope,
): VoiceRecognitionConstructor | null {
  return scope?.SpeechRecognition ?? scope?.webkitSpeechRecognition ?? null;
}

export function collectVoiceTranscript(
  results: VoiceRecognitionResultList,
  resultIndex = 0,
): { finalTranscript: string; interimTranscript: string } {
  const finalSegments: string[] = [];
  const interimSegments: string[] = [];
  for (let index = resultIndex; index < results.length; index += 1) {
    const result = results[index];
    const transcript = result?.[0]?.transcript?.trim();
    if (!transcript) continue;
    (result.isFinal ? finalSegments : interimSegments).push(transcript);
  }
  return {
    finalTranscript: finalSegments.join(" "),
    interimTranscript: interimSegments.join(" "),
  };
}

export function appendVoiceTranscript(current: string, next: string): string {
  const left = current.trim();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

export function composeVoiceDraft(
  prefix: string,
  finalTranscript: string,
  interimTranscript: string,
): string {
  const spoken = [finalTranscript, interimTranscript]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
  if (!spoken) return prefix.trimEnd();
  return `${prefix}${spoken}`;
}

export function voiceInputErrorMessage(error: string): string {
  switch (error) {
    case "not-allowed":
      return "Microphone access was blocked. Allow it in your browser or system settings, then try again.";
    case "service-not-allowed":
      return "This browser does not allow its speech service for Aldunis Code.";
    case "audio-capture":
      return "No microphone was found. Connect one and try again.";
    case "no-speech":
      return "No speech was detected. Try again when you are ready.";
    case "network":
      return "The browser speech service is unavailable. Check your connection and try again.";
    default:
      return "Voice input could not start. Try again.";
  }
}
