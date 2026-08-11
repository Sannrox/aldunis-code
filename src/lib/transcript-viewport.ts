import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createThreadBottomSettler,
  nextThreadFollowEnabled,
  readThreadScrollMetrics,
  scrollThreadToBottom,
  shouldPinThreadToBottom,
} from "./thread-auto-follow";
import {
  readThreadScrollPosition,
  restoreThreadScrollTop,
  shouldRestoreThreadScrollOnOpen,
  snapshotThreadScroll,
  writeThreadScrollPosition,
  type ConversationOpenScroll,
} from "./thread-open-scroll";

export interface TranscriptViewportInput {
  /** Stable pane binding; unlike conversationId, it does not change when a new run is accepted. */
  scopeKey: string;
  conversationId: string | null;
  openScroll: ConversationOpenScroll;
  historyReady: boolean;
  empty: boolean;
  /** Changes whenever rendered transcript content can affect layout height. */
  contentKey: string;
  /** Changes when an adjacent panel can resize the transcript viewport. */
  layoutKey: string;
}

/**
 * Owns one transcript viewport's browser lifetime: open placement, following,
 * remembered position, content growth, explicit resume, resize, and cleanup.
 */
export function useTranscriptViewport(input: TranscriptViewportInput) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const ignoreScrollRef = useRef(false);
  const openPlacementAppliedRef = useRef(false);
  const scopeKeyRef = useRef(input.scopeKey);
  const initialScopeEffectRef = useRef(true);
  const awaitingHistoryResetRef = useRef(false);
  const bindingRef = useRef({
    conversationId: input.conversationId,
    openScroll: input.openScroll,
  });
  const bottomSettlerRef = useRef<ReturnType<typeof createThreadBottomSettler> | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const [following, setFollowingState] = useState(true);

  const setFollowing = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowingState(value);
  }, []);

  const suppressOwnScroll = useCallback((change: () => void) => {
    ignoreScrollRef.current = true;
    change();
    queueMicrotask(() => {
      ignoreScrollRef.current = false;
    });
  }, []);

  const pinToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    suppressOwnScroll(() => scrollThreadToBottom(viewport));
  }, [suppressOwnScroll]);

  const resetToTop = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || viewport.scrollTop === 0) return;
    suppressOwnScroll(() => {
      viewport.scrollTop = 0;
    });
  }, [suppressOwnScroll]);

  const persistFor = useCallback(
    (conversationId: string | null, openScroll: ConversationOpenScroll) => {
      const viewport = viewportRef.current;
      if (openScroll !== "remember" || !conversationId || !viewport) return;
      writeThreadScrollPosition(
        conversationId,
        snapshotThreadScroll({
          ...readThreadScrollMetrics(viewport),
          following: followingRef.current,
        }),
        typeof window === "undefined" ? null : window.localStorage,
      );
    },
    [],
  );

  const persist = useCallback(() => {
    const current = inputRef.current;
    persistFor(current.conversationId, current.openScroll);
  }, [persistFor]);

  const onScroll = useCallback(() => {
    if (ignoreScrollRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nextFollowing = nextThreadFollowEnabled(readThreadScrollMetrics(viewport));
    if (!nextFollowing) bottomSettlerRef.current?.cancel();
    setFollowing(nextFollowing);
    persist();
  }, [persist, setFollowing]);

  const engageFollow = useCallback(() => setFollowing(true), [setFollowing]);

  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    const viewport = viewportRef.current;
    if (!viewport) return;
    const settler =
      bottomSettlerRef.current ??
      createThreadBottomSettler(
        (callback) => requestAnimationFrame(callback),
        (handle) => cancelAnimationFrame(handle),
      );
    bottomSettlerRef.current = settler;
    suppressOwnScroll(() => settler.settle(viewport));
  }, [setFollowing, suppressOwnScroll]);

  useLayoutEffect(() => {
    if (scopeKeyRef.current !== input.scopeKey) {
      persistFor(bindingRef.current.conversationId, bindingRef.current.openScroll);
      scopeKeyRef.current = input.scopeKey;
      bottomSettlerRef.current?.cancel();
      openPlacementAppliedRef.current = false;
      followingRef.current = true;
      awaitingHistoryResetRef.current = true;
      bindingRef.current = {
        conversationId: input.conversationId,
        openScroll: input.openScroll,
      };
      // Conversation resets its history in a passive effect. Defer placement
      // until that reset (and eventual restoration) has produced a fresh render.
      return;
    }
    if (awaitingHistoryResetRef.current) {
      // Existing conversations reset history in Conversation's passive effect.
      // Do not consume remembered placement while the previous transcript is
      // still rendered and reports ready/non-empty.
      if (input.historyReady && !input.empty) return;
      awaitingHistoryResetRef.current = false;
    }
    bindingRef.current = {
      conversationId: input.conversationId,
      openScroll: input.openScroll,
    };
    if (!input.historyReady) {
      if (input.empty) resetToTop();
      return;
    }
    if (input.empty) {
      openPlacementAppliedRef.current = true;
      resetToTop();
      return;
    }
    if (!openPlacementAppliedRef.current) {
      openPlacementAppliedRef.current = true;
      const saved =
        input.openScroll === "remember"
          ? readThreadScrollPosition(
              input.conversationId,
              typeof window === "undefined" ? null : window.localStorage,
            )
          : null;
      if (shouldRestoreThreadScrollOnOpen(input.openScroll, saved) && saved) {
        const viewport = viewportRef.current;
        if (viewport) {
          setFollowing(false);
          suppressOwnScroll(() => restoreThreadScrollTop(viewport, saved));
        }
        return;
      }
      setFollowing(true);
      pinToBottom();
      return;
    }
    if (shouldPinThreadToBottom(followingRef.current, !input.empty)) pinToBottom();
  }, [
    input.contentKey,
    input.conversationId,
    input.empty,
    input.historyReady,
    input.layoutKey,
    input.openScroll,
    input.scopeKey,
    pinToBottom,
    persistFor,
    resetToTop,
    setFollowing,
    suppressOwnScroll,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      if (inputRef.current.empty) {
        resetToTop();
        return;
      }
      if (shouldPinThreadToBottom(followingRef.current, true)) pinToBottom();
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [input.conversationId, input.historyReady, pinToBottom, resetToTop]);

  useEffect(() => {
    if (initialScopeEffectRef.current) {
      initialScopeEffectRef.current = false;
      return;
    }
    setFollowing(true);
  }, [input.scopeKey, setFollowing]);

  useEffect(
    () => () => {
      persistFor(bindingRef.current.conversationId, bindingRef.current.openScroll);
      bottomSettlerRef.current?.cancel();
    },
    [persistFor],
  );

  return {
    contentRef,
    engageFollow,
    following,
    jumpToLatest,
    onScroll,
    viewportRef,
  };
}
