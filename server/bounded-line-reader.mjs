/**
 * Frame bounded newline-delimited bytes without repeatedly copying a partial line.
 *
 * @param {AsyncIterable<Buffer | Uint8Array | string>} input
 * @param {number} maxLineBytes
 * @param {string} overflowMessage
 * @param {{
 *   trailer?: "reject" | "yield" | "discard" | (() => "reject" | "yield" | "discard"),
 *   incompleteMessage?: string,
 *   error?: (message: string) => Error,
 * }} [options]
 */
export async function* readBoundedLines(input, maxLineBytes, overflowMessage, options = {}) {
  const failure = options.error ?? ((message) => new Error(message));
  let chunks = [];
  let length = 0;

  for await (const rawChunk of input) {
    let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    while (chunk.byteLength > 0) {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      length += part.byteLength;
      if (length > maxLineBytes) throw failure(overflowMessage);
      if (part.byteLength > 0) chunks.push(part);

      if (newline === -1) break;
      yield chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
      chunks = [];
      length = 0;
      chunk = chunk.subarray(newline + 1);
    }
  }

  if (length > 0) {
    const trailer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
    if (!trailer.toString("utf8").trim()) return;
    const policy =
      typeof options.trailer === "function" ? options.trailer() : (options.trailer ?? "reject");
    if (policy === "yield") {
      yield trailer;
      return;
    }
    if (policy === "discard") return;
    throw failure(options.incompleteMessage ?? "incomplete JSON-RPC message");
  }
}
