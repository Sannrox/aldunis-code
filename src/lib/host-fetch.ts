export type HostFetch = typeof fetch;

/**
 * Call platform fetch as a Window/global method. Storing `fetch` on another
 * object and invoking it as `this.request(...)` throws
 * "Can only call Window.fetch on instances of Window" in Chromium.
 */
export const hostFetch: HostFetch = (input, init) => globalThis.fetch(input, init);
