export const MAX_RETAINED_BYTE_FRAGMENTS = 256;
export const RETAINED_BYTE_COMPACTION_TARGET_BYTES = 64 * 1024;

/**
 * Collect a byte stream without retaining one object per input fragment.
 *
 * @param {AsyncIterable<Buffer | Uint8Array | string> | Iterable<Buffer | Uint8Array | string>} input
 * @param {number} maxBytes
 * @param {string} overflowMessage
 * @param {{ error?: (message: string) => Error }} [options]
 */
export async function readBoundedBytes(input, maxBytes, overflowMessage, options = {}) {
  const failure = options.error ?? ((message) => new Error(message));
  let fragments = [];
  let fragmentBytes = 0;
  let batches = [];
  let batchBytes = 0;
  const slabs = [];
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
    if (batchBytes >= RETAINED_BYTE_COMPACTION_TARGET_BYTES) flushBatches();
  };

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    length += chunk.byteLength;
    if (length > maxBytes) throw failure(overflowMessage);
    if (chunk.byteLength === 0) continue;
    fragments.push(chunk);
    fragmentBytes += chunk.byteLength;
    if (fragments.length >= MAX_RETAINED_BYTE_FRAGMENTS) {
      compacting = true;
      flushFragments();
    }
  }

  if (!compacting) {
    return fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, length);
  }
  flushFragments();
  flushBatches();
  return slabs.length === 1 ? slabs[0] : Buffer.concat(slabs, length);
}
