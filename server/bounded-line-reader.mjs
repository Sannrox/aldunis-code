export async function* readBoundedLines(input, maxLineBytes, overflowMessage) {
  let chunks = [];
  let length = 0;

  for await (const rawChunk of input) {
    let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    while (chunk.byteLength > 0) {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      length += part.byteLength;
      if (length > maxLineBytes) throw new Error(overflowMessage);
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
    if (trailer.toString("utf8").trim()) throw new Error("incomplete JSON-RPC message");
  }
}
