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
export const MAX_RETAINED_LINE_FRAGMENTS = 256;
export const RETAINED_LINE_COMPACTION_TARGET_BYTES = 64 * 1024;

export async function* readBoundedLines(input, maxLineBytes, overflowMessage, options = {}) {
  const failure = options.error ?? ((message) => new Error(message));
  let fragments = [];
  let fragmentBytes = 0;
  let batches = [];
  let batchBytes = 0;
  let slabs = [];
  let compacting = false;
  let length = 0;

  const flushBatches = () => {
    if (batchBytes === 0) return;
    slabs.push(batches.length === 1 ? batches[0] : Buffer.concat(batches, batchBytes));
    batches = [];
    batchBytes = 0;
  };
  const flushFragments = () => {
    if (fragmentBytes === 0) return;
    const batch = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
    batches.push(batch);
    batchBytes += batch.byteLength;
    fragments = [];
    fragmentBytes = 0;
    if (batchBytes >= RETAINED_LINE_COMPACTION_TARGET_BYTES) flushBatches();
  };
  const take = () => {
    let line;
    if (!compacting) {
      line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, length);
    } else {
      flushFragments();
      flushBatches();
      line = slabs.length === 1 ? slabs[0] : Buffer.concat(slabs, length);
    }
    fragments = [];
    fragmentBytes = 0;
    batches = [];
    batchBytes = 0;
    slabs = [];
    compacting = false;
    length = 0;
    return line;
  };

  for await (const rawChunk of input) {
    let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    while (chunk.byteLength > 0) {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      length += part.byteLength;
      if (length > maxLineBytes) throw failure(overflowMessage);
      if (part.byteLength > 0) {
        fragments.push(part);
        fragmentBytes += part.byteLength;
        if (fragments.length >= MAX_RETAINED_LINE_FRAGMENTS) {
          compacting = true;
          flushFragments();
        }
      }

      if (newline === -1) break;
      yield take();
      chunk = chunk.subarray(newline + 1);
    }
  }

  if (length > 0) {
    const trailer = take();
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
