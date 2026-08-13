export const MAX_APPROVAL_RESPONSE_BYTES = 64 * 1024;
export const APPROVAL_REQUEST_TIMEOUT_MS = 5 * 60_000 + 5_000;

async function readBoundedResponse(response) {
  const rawLength = response.headers.get("content-length");
  const contentLength = rawLength === null ? null : Number(rawLength);
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new Error("Permission broker returned an invalid response length.");
  }
  if (contentLength !== null && contentLength > MAX_APPROVAL_RESPONSE_BYTES) {
    throw new Error("Permission broker response exceeds the 64 KiB limit.");
  }
  if (!response.body) return "";
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_APPROVAL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Permission broker response exceeds the 64 KiB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function requestApproval(url, init, request = globalThis.fetch) {
  const response = await request(url, {
    ...init,
    signal: AbortSignal.timeout(APPROVAL_REQUEST_TIMEOUT_MS),
  });
  const text = await readBoundedResponse(response);
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Permission broker returned invalid JSON.");
  }
  return { response, result };
}
