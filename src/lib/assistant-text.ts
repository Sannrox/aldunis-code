/**
 * Reconstruct streamed assistant text from discrete provider chunks.
 *
 * ACP agents (notably Grok Build) emit many tiny agent_message_chunk frames,
 * often sub-word tokens, plus occasional whitespace-only frames ("\\n\\n").
 * Chunks must be concatenated as-is — never with injected separators.
 *
 * Some streams omit the leading newline before a markdown block marker when
 * the previous token ended mid-line (e.g. "steps." + "##"). Insert a single
 * newline only at those block boundaries so headings/code fences stay readable.
 */
export function joinAssistantTextChunks(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  const output: string[] = [];
  let hasOutput = false;
  let endsWithWhitespace = false;
  for (const next of parts) {
    if (next.length === 0) continue;
    const needsBlockBreak =
      hasOutput && !endsWithWhitespace && /^(#{1,6}(?=\s|#|$)|```|---(?:\s|$))/.test(next);
    if (needsBlockBreak) output.push("\n");
    output.push(next);
    hasOutput = true;
    endsWithWhitespace = /\s$/.test(next);
  }
  return output.join("");
}
