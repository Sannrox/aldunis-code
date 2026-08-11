export const PREVIEW_ELEMENT_REFERENCE_TIMEOUT_MS = 10_000;

interface PreviewElementReferenceTimers {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

const browserTimers: PreviewElementReferenceTimers = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export function isCurrentPreviewElementReferenceResponse(
  value: unknown,
  requestId: string | null,
): value is Record<string, unknown> & {
  type: "aldunis-preview:element-error" | "aldunis-preview:element-reference";
  requestId: string;
} {
  if (!value || typeof value !== "object" || !requestId) return false;
  const response = value as Record<string, unknown>;
  return (
    response.requestId === requestId &&
    (response.type === "aldunis-preview:element-error" ||
      response.type === "aldunis-preview:element-reference")
  );
}

/** Owns the single fallback deadline for the current preview element selection. */
export class PreviewElementReferenceDeadline {
  #timer: number | null = null;

  constructor(private readonly timers: PreviewElementReferenceTimers = browserTimers) {}

  start(onTimeout: () => void, delayMs = PREVIEW_ELEMENT_REFERENCE_TIMEOUT_MS): void {
    this.clear();
    const timer = this.timers.setTimeout(() => {
      if (this.#timer !== timer) return;
      this.#timer = null;
      onTimeout();
    }, delayMs);
    this.#timer = timer;
  }

  clear(): void {
    if (this.#timer === null) return;
    this.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  get pending(): boolean {
    return this.#timer !== null;
  }
}
