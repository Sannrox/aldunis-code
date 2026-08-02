/** Distance from the bottom that still counts as “holding the tail”. */
export const THREAD_FOLLOW_THRESHOLD_PX = 72;

export interface ThreadScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** Pixels between the viewport bottom and the content bottom (clamped at 0). */
export function threadDistanceFromBottom(metrics: ThreadScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function threadHasOverflow(metrics: ThreadScrollMetrics): boolean {
  return metrics.scrollHeight > metrics.clientHeight + 1;
}

/** True when the operator is still at (or near) the latest content. */
export function isNearThreadBottom(
  metrics: ThreadScrollMetrics,
  thresholdPx = THREAD_FOLLOW_THRESHOLD_PX,
): boolean {
  return threadDistanceFromBottom(metrics) <= thresholdPx;
}

/**
 * Whether auto-follow should stay enabled after a scroll position change.
 * Empty / non-overflowing threads always follow so the first growth sticks.
 */
export function nextThreadFollowEnabled(
  metrics: ThreadScrollMetrics,
  thresholdPx = THREAD_FOLLOW_THRESHOLD_PX,
): boolean {
  if (!threadHasOverflow(metrics)) return true;
  return isNearThreadBottom(metrics, thresholdPx);
}

/** Jump the scroll container to the latest content (instant). */
export function scrollThreadToBottom(target: { scrollTop: number; scrollHeight: number }): void {
  target.scrollTop = target.scrollHeight;
}

export function readThreadScrollMetrics(element: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): ThreadScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  };
}
