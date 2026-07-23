import type { FileDiff } from "./changes.ts";
import type { DiffAnnotation } from "./state.ts";

export const MAX_ANNOTATION_TEXT = 2_000;
export const MAX_REVISION_ANNOTATIONS = 20;
export const MAX_REVISION_CONTEXT = 16_000;

export interface AnnotationView extends DiffAnnotation {
  stale: boolean;
  staleReason: string | null;
}

export function annotationView(
  annotation: DiffAnnotation,
  current: FileDiff | null,
): AnnotationView {
  if (!current) {
    return { ...annotation, stale: true, staleReason: "The target is no longer a changed file." };
  }
  if (current.identity !== annotation.diffIdentity) {
    return { ...annotation, stale: true, staleReason: "The diff changed after this annotation was created." };
  }
  return { ...annotation, stale: false, staleReason: null };
}

export function captureAnnotationContext(
  diff: FileDiff,
  lineIndex: number | null,
): string {
  if (lineIndex === null) {
    return diff.patch?.split("\n").slice(0, 12).join("\n") ?? diff.message ?? diff.state;
  }
  const target = diff.lines.find((line) => line.index === lineIndex);
  if (!target || target.side === "metadata") {
    throw new Error("Select a commentable diff line.");
  }
  return diff.lines
    .filter((line) => Math.abs(line.index - target.index) <= 3)
    .map((line) => line.content)
    .join("\n");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fence(contents: string): string {
  const longest = Math.max(0, ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length));
  const delimiter = "`".repeat(Math.max(3, longest + 1));
  return `${delimiter}diff\n${contents.trimEnd()}\n${delimiter}`;
}

export function formatRevisionContext(annotations: readonly AnnotationView[]): string {
  if (annotations.length === 0 || annotations.length > MAX_REVISION_ANNOTATIONS) {
    throw new Error(`Select between 1 and ${MAX_REVISION_ANNOTATIONS} annotations.`);
  }
  const blocks = annotations.map((annotation) => {
    const location = annotation.scope === "file"
      ? "file"
      : annotation.side === "deletion"
      ? `old line ${annotation.oldLine}`
      : `new line ${annotation.newLine}`;
    return [
      `<review_comment id="${escapeAttribute(annotation.id)}" path="${escapeAttribute(annotation.path)}" target="${escapeAttribute(location)}" diffIdentity="${annotation.diffIdentity}" stale="${annotation.stale}">`,
      annotation.text,
      fence(annotation.capturedContext),
      "</review_comment>",
    ].join("\n");
  });
  const prompt = [
    "Address the selected local diff review comments. Treat stale targets as historical context and verify the current file before changing it.",
    "",
    ...blocks.flatMap((block, index) => index === 0 ? [block] : ["", block]),
  ].join("\n");
  if (prompt.length > MAX_REVISION_CONTEXT) {
    throw new Error(`Selected review context exceeds ${MAX_REVISION_CONTEXT} characters.`);
  }
  return prompt;
}
